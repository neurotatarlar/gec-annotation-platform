import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Annotation, AnnotationTask, Base, Category, TextSample, User, SkippedText
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
    ]
    # JSONB not supported in SQLite; coerce to JSON for tests.
    Annotation.__table__.c.payload.type = JSON()
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


def test_next_text_skips_already_submitted_count(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text A").one()
        # two submitted tasks already, meeting required_annotations=2
        session.add_all(
            [
                AnnotationTask(text_id=text.id, annotator_id=uuid.uuid4(), status="submitted"),
                AnnotationTask(text_id=text.id, annotator_id=uuid.uuid4(), status="submitted"),
            ]
        )
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Should assign text B instead, because text A already has enough submissions.
    assert body["text"]["content"] == "text B"


def test_next_text_allows_additional_reviews_until_required(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="text A").one()
        # only one submitted so far; required_annotations=2 means it should still be assignable
        session.add(AnnotationTask(text_id=text.id, annotator_id=uuid.uuid4(), status="submitted"))
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"]["content"] == "text A"


def test_next_text_ignores_texts_already_assigned_to_user(client):
    with db.SessionLocal() as session:
        text_a = session.query(TextSample).filter_by(content="text A").one()
        session.add(AnnotationTask(text_id=text_a.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()

    resp = client.post("/api/texts/assignments/next", params={"category_id": 1})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # text A is already assigned to the current user; next should be text B
    assert body["text"]["content"] == "text B"


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
