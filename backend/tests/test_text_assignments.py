import os
import hashlib
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Annotation, AnnotationTask, AnnotationVersion, Base, Category, CrossValidationResult, ErrorType, TextSample, User, SkippedText
from app.services.auth import get_current_user, get_db


def override_get_db():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


TEST_USER_ID = uuid.uuid4()


def override_get_current_user():
    return User(
        id=TEST_USER_ID,
        username="tester",
        password_hash="x",
        role="annotator",
        is_active=True,
    )


@pytest.fixture(autouse=True)
def setup_db():
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        AnnotationTask.__table__,
        SkippedText.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
        ErrorType.__table__,
        CrossValidationResult.__table__,
    ]
    # JSONB not supported in SQLite; coerce to JSON for tests.
    Annotation.__table__.c.payload.type = JSON()
    AnnotationVersion.__table__.c.snapshot.type = JSON()
    CrossValidationResult.__table__.c.result.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)

    with db.SessionLocal() as session:
        user = User(
            id=TEST_USER_ID,
            username="tester",
            password_hash="x",
            role="annotator",
            is_active=True,
        )
        session.add(user)
        category = Category(name="Demo")
        session.add(category)
        session.flush()
        error_type = ErrorType(en_name="OTHER", default_color="#f97316", is_active=True)
        session.add(error_type)
        session.add_all(
            [
                TextSample(content="text A", category_id=category.id, required_annotations=2),
                TextSample(content="text B", category_id=category.id, required_annotations=1),
            ]
        )
        session.commit()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    yield

    Base.metadata.drop_all(bind=db.engine, tables=tables)
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.parametrize("status", ["submitted", "skip", "trash"])
def test_next_text_ignores_terminal_tasks_from_any_annotator(client, status):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text A").one()
        session.add(AnnotationTask(text_id=text.id, annotator_id=uuid.uuid4(), status=status))
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Should assign text B instead because text A already has a terminal task.
    assert body["text"]["content"] == "text B"


def test_next_text_returns_404_when_all_texts_terminal(client):
    with db.SessionLocal() as session:
        text_a = session.query(TextSample).filter_by(content="text A").one()
        text_b = session.query(TextSample).filter_by(content="text B").one()
        session.add_all(
            [
                AnnotationTask(text_id=text_a.id, annotator_id=uuid.uuid4(), status="submitted"),
                AnnotationTask(text_id=text_b.id, annotator_id=uuid.uuid4(), status="trash"),
            ]
        )
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 404, resp.text


def test_next_text_returns_existing_assignment_for_user(client):
    with db.SessionLocal() as session:
        text_a = session.query(TextSample).filter_by(content="text A").one()
        session.add(AnnotationTask(text_id=text_a.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # text A is already assigned to the current user; it should be returned again
    assert body["text"]["content"] == "text A"
    with db.SessionLocal() as session:
        refreshed = session.get(TextSample, body["text"]["id"])
        assert refreshed.locked_by_id == TEST_USER_ID
        assert refreshed.state == "in_annotation"
        assert refreshed.locked_at is not None


def test_import_sets_required_annotations_and_assignment_respects_skip_states(client):
    with db.SessionLocal() as session:
        category = session.query(Category).first()
        resp = client.post(
            "/api/texts/import",
            json={
                "category_id": category.id,
                "texts": ["text C"],
                "required_annotations": 3,
            },
        )
        assert resp.status_code == 201, resp.text

        imported = session.query(TextSample).filter_by(content="text C").one()
        assert imported.required_annotations == 3

        # mark existing texts as unavailable
        text_a = session.query(TextSample).filter_by(content="text A").one()
        text_b = session.query(TextSample).filter_by(content="text B").one()
        text_a.state = "skipped"
        text_b.state = "trash"
        session.commit()

    resp2 = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp2.status_code == 200, resp2.text
    body2 = resp2.json()
    # Should skip skipped/trash texts and pick the imported one.
    assert body2["text"]["content"] == "text C"


def test_import_accepts_json_objects_and_preserves_newlines(client):
    payload = {
        "category_id": 1,
        "texts": [
            {"id": "ext-1", "text": "Line one\n\nLine two"},
            {"text": "Another text"},
        ],
        "required_annotations": 1,
    }
    resp = client.post("/api/texts/import", json=payload)
    assert resp.status_code == 201, resp.text
    assert resp.json()["inserted"] == 2
    with db.SessionLocal() as session:
        first = session.query(TextSample).filter_by(external_id="ext-1").one()
        assert first.content == "Line one\n\nLine two"
        second_hash = hashlib.sha256("Another text".encode("utf-8")).hexdigest()
        second = session.query(TextSample).filter_by(external_id=second_hash).one()
        assert second.content == "Another text"


def test_import_skips_duplicates_by_external_id(client):
    with db.SessionLocal() as session:
        category = session.query(Category).first()
        session.add(
            TextSample(
                content="existing",
                category_id=category.id,
                required_annotations=1,
                external_id="dup-1",
            )
        )
        session.commit()

    payload = {
        "category_id": 1,
        "texts": [
            {"id": "dup-1", "text": "should be skipped"},
            {"id": "new-1", "text": "fresh"},
        ],
        "required_annotations": 1,
    }
    resp = client.post("/api/texts/import", json=payload)
    assert resp.status_code == 201, resp.text
    assert resp.json()["inserted"] == 1
    with db.SessionLocal() as session:
        all_rows = session.query(TextSample).filter_by(category_id=1).all()
        ext_ids = {row.external_id for row in all_rows}
        assert "dup-1" in ext_ids
        assert "new-1" in ext_ids
        existing = session.query(TextSample).filter_by(external_id="dup-1").one()
        assert existing.content == "existing"


def test_import_m2_creates_annotations(client):
    m2 = """S hello world
A 0 0|||ART|||hi|||REQUIRED|||-NONE-|||0
"""
    resp = client.post(
        "/api/texts/import",
        json={"category_id": 1, "required_annotations": 1, "m2_content": m2},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["inserted"] == 1
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="hello world").one()
        task = session.query(AnnotationTask).filter_by(text_id=text.id).one()
        annotations = session.query(Annotation).filter_by(text_id=text.id).all()
        assert task.status == "submitted"
        assert len(annotations) == 1
        assert annotations[0].replacement == "hi"
        assert annotations[0].payload.get("operation") == "replace"
        assert text.state in {"awaiting_cross_validation", "pending"}


def test_list_annotations_all_authors(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text A").one()
        text_id = text.id
        other_user = User(
            id=uuid.uuid4(),
            username="other",
            password_hash="x",
            role="annotator",
            is_active=True,
        )
        session.add(other_user)
        session.add_all(
            [
                AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="in_progress"),
                AnnotationTask(text_id=text.id, annotator_id=other_user.id, status="submitted"),
            ]
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=other_user.id,
                start_token=0,
                end_token=0,
                replacement="x",
                error_type_id=session.query(ErrorType).first().id,
                payload={
                    "operation": "replace",
                    "before_tokens": ["tok1"],
                    "after_tokens": [{"id": "tok2", "text": "x", "origin": "base"}],
                    "text_tokens": ["text", "A"],
                },
            )
        )
        session.commit()

    resp = client.get(f"/api/texts/{text_id}/annotations?all_authors=true")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data) == 1
    assert data[0]["author_id"] != str(TEST_USER_ID)


def test_submission_clears_flags_for_exclusive_state(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text B").one()
        session.add(AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()
        text_id = text.id

    resp_skip = client.post(f"/api/texts/{text_id}/skip", json={"reason": "later"})
    assert resp_skip.status_code == 204, resp_skip.text
    with db.SessionLocal() as session:
        skip_row = (
            session.query(SkippedText)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID, flag_type="skip")
            .one_or_none()
        )
        task = (
            session.query(AnnotationTask)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .one()
        )
        assert skip_row is not None
        assert task.status == "skip"

    resp_submit = client.post(f"/api/texts/{text_id}/submit")
    assert resp_submit.status_code == 202, resp_submit.text

    with db.SessionLocal() as session:
        remaining_flags = (
            session.query(SkippedText)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .all()
        )
        task = (
            session.query(AnnotationTask)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .one()
        )
        text_row = session.get(TextSample, text_id)

        assert remaining_flags == []
        assert task.status == "submitted"
        assert text_row.state != "skipped"
        assert text_row.state != "trash"


def test_flag_overrides_prior_submission_exclusively(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text B").one()
        session.add(AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="submitted"))
        session.commit()
        text_id = text.id

    resp = client.post(f"/api/texts/{text_id}/trash", json={"reason": "bad"})
    assert resp.status_code == 204, resp.text

    with db.SessionLocal() as session:
        flags = session.query(SkippedText).filter_by(text_id=text_id, annotator_id=TEST_USER_ID).all()
        task = (
            session.query(AnnotationTask)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .one()
        )
        text_row = session.get(TextSample, text_id)

        assert len(flags) == 1
        assert flags[0].flag_type == "trash"
        assert task.status == "trash"
        assert text_row.state == "trash"


def test_submit_creates_assignment_and_noop_when_missing(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text B").one()
        session.query(AnnotationTask).delete()
        session.query(Annotation).delete()
        session.commit()
        text_id = text.id

    resp = client.post(f"/api/texts/{text_id}/submit")
    assert resp.status_code == 202, resp.text

    with db.SessionLocal() as session:
        task = (
            session.query(AnnotationTask)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .one()
        )
        anns = (
            session.query(Annotation)
            .filter_by(text_id=text_id, author_id=TEST_USER_ID)
            .all()
        )
        text_row = session.get(TextSample, text_id)
        cv = session.query(CrossValidationResult).filter_by(text_id=text_id).one_or_none()

        assert task.status == "submitted"
        assert len(anns) == 1
        ann = anns[0]
        assert ann.payload.get("operation") == "noop"
        assert ann.start_token == -1 and ann.end_token == -1
        assert ann.payload.get("text_tokens") == text_row.content.split()
        assert session.get(ErrorType, ann.error_type_id) is not None
        assert text_row.state == "awaiting_cross_validation"
        assert cv is not None


def test_switch_between_skip_and_trash_is_exclusive(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text B").one()
        session.add(AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()
        text_id = text.id

    resp_skip = client.post(f"/api/texts/{text_id}/skip", json={"reason": "skip first"})
    assert resp_skip.status_code == 204, resp_skip.text

    resp_trash = client.post(f"/api/texts/{text_id}/trash", json={"reason": "actually trash"})
    assert resp_trash.status_code == 204, resp_trash.text

    with db.SessionLocal() as session:
        flags = session.query(SkippedText).filter_by(text_id=text_id, annotator_id=TEST_USER_ID).all()
        task = (
            session.query(AnnotationTask)
            .filter_by(text_id=text_id, annotator_id=TEST_USER_ID)
            .one()
        )

        assert len(flags) == 1
        assert flags[0].flag_type == "trash"
        assert task.status == "trash"


def test_import_skips_duplicate_plain_strings_by_hash(client):
    payload = {
        "category_id": 1,
        "texts": [
            "repeat me",
            "repeat me",  # duplicate plain string should be skipped
            "unique",
        ],
        "required_annotations": 1,
    }
    resp = client.post("/api/texts/import", json=payload)
    assert resp.status_code == 201, resp.text
    assert resp.json()["inserted"] == 2
    with db.SessionLocal() as session:
        rows = session.query(TextSample).filter_by(category_id=1).all()
        contents = {r.content for r in rows}
        assert "repeat me" in contents
        assert "unique" in contents
