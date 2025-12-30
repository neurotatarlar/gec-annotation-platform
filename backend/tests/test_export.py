import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import (
    Annotation,
    AnnotationTask,
    AnnotationVersion,
    Base,
    Category,
    ErrorType,
    TextSample,
    User,
    CrossValidationResult,
)
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
        Annotation.__table__,
        AnnotationVersion.__table__,
        ErrorType.__table__,
        CrossValidationResult.__table__,
    ]
    Annotation.__table__.c.payload.type = JSON()
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
        category = Category(name="ExportCat")
        session.add(category)
        session.flush()
        submitted_text = TextSample(content="hello world", category_id=category.id, required_annotations=1)
        trashed_text = TextSample(content="trash me", category_id=category.id, required_annotations=1, state="trash")
        session.add_all([submitted_text, trashed_text])
        error_type = ErrorType(en_name="ART", default_color="#f97316", is_active=True)
        session.add(error_type)
        session.flush()
        session.add(
            AnnotationTask(
                text_id=submitted_text.id,
                annotator_id=TEST_USER_ID,
                status="submitted",
            )
        )
        session.add(
            AnnotationTask(
                text_id=trashed_text.id,
                annotator_id=TEST_USER_ID,
                status="trash",
            )
        )
        session.add(
            Annotation(
                text_id=submitted_text.id,
                author_id=TEST_USER_ID,
                start_token=0,
                end_token=0,
                replacement="hi",
                error_type_id=error_type.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["hello", "world"],
                    "text_tokens_sha256": "x",
                    "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                },
            )
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


def parse_m2_block(block: str) -> dict:
    lines = [line.strip() for line in block.strip().splitlines() if line.strip()]
    assert lines and lines[0].startswith("S ")
    tokens = lines[0][2:].split()
    anns = []
    for line in lines[1:]:
        assert line.startswith("A ")
        parts = line[2:].split("|||")
        span = parts[0].split()
        start, end = int(span[0]), int(span[1])
        label = parts[1]
        replacement = parts[2]
        annotator = parts[5] if len(parts) > 5 else None
        anns.append(
            {
                "start": start,
                "end": end,
                "label": label,
                "replacement": replacement,
                "annotator": annotator,
            }
        )
    return {"tokens": tokens, "annotations": anns}


def test_export_includes_only_submitted(client):
    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    body = resp.text.strip()
    assert "S hello world" in body
    assert f"A 0 0|||ART|||hi|||REQUIRED|||-NONE-|||{TEST_USER_ID}" in body
    assert "trash me" not in body


def test_export_single_text_include_all_returns_all_authors(client):
    other_id = uuid.uuid4()
    with db.SessionLocal() as session:
        session.add(
            User(
                id=other_id,
                username="other",
                password_hash="x",
                role="annotator",
                is_active=True,
            )
        )
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="alpha beta", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        text_id = text.id
        error_type = session.query(ErrorType).first()
        session.add(
            Annotation(
                text_id=text.id,
                author_id=TEST_USER_ID,
                start_token=0,
                end_token=0,
                replacement="ALPHA",
                error_type_id=error_type.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["alpha", "beta"],
                    "text_tokens_sha256": "x",
                    "after_tokens": [{"id": "a1", "text": "ALPHA", "origin": "base"}],
                },
            )
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=other_id,
                start_token=1,
                end_token=1,
                replacement="BETA",
                error_type_id=error_type.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["alpha", "beta"],
                    "text_tokens_sha256": "x",
                    "after_tokens": [{"id": "b1", "text": "BETA", "origin": "base"}],
                },
            )
        )
        session.commit()

    resp = client.get(f"/api/texts/{text_id}/export", params={"include_all": "true"})
    assert resp.status_code == 200, resp.text
    blocks = [b for b in resp.text.strip().split("\n\n") if b.strip()]
    assert len(blocks) == 2
    parsed = [parse_m2_block(block) for block in blocks]
    assert parsed[0]["tokens"] == ["alpha", "beta"]
    assert parsed[1]["tokens"] == ["alpha", "beta"]
    labels = {ann["label"] for block in parsed for ann in block["annotations"]}
    assert "ART" in labels
    annotators = {ann["annotator"] for block in parsed for ann in block["annotations"]}
    assert "tester" in annotators
    assert "other" in annotators


def test_export_includes_noop_when_no_annotations(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="plain sample", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        session.add(
          AnnotationTask(
            text_id=text.id,
            annotator_id=TEST_USER_ID,
            status="submitted",
          )
        )
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    body = resp.text
    assert "S plain sample" in body
    assert f"A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||{TEST_USER_ID}" in body


def test_export_filters_by_category(client):
    resp = client.get("/api/texts/export", params={"category_ids": "999"})
    assert resp.status_code == 200, resp.text
    assert resp.text.strip() == ""


def test_export_uses_payload_token_snapshot_and_orders_annotations(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="foo-bar baz", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        error_type = session.query(ErrorType).first()
        session.add(
            AnnotationTask(
                text_id=text.id,
                annotator_id=TEST_USER_ID,
                status="submitted",
            )
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=TEST_USER_ID,
                start_token=2,
                end_token=2,
                replacement=None,
                error_type_id=error_type.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["foo", "bar", "baz"],
                    "text_tokens_sha256": "hash",
                    "after_tokens": [{"id": "a3", "text": "qux", "origin": "base"}, {"id": "a4", "text": "quux", "origin": "base"}],
                },
            )
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=TEST_USER_ID,
                start_token=1,
                end_token=1,
                replacement=None,
                error_type_id=error_type.id,
                payload={
                    "operation": "delete",
                    "text_tokens": ["foo", "bar", "baz"],
                    "text_tokens_sha256": "hash",
                    "after_tokens": [],
                },
            )
        )
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    block = next(b for b in resp.text.strip().split("\n\n") if b.startswith("S foo bar baz"))
    lines = block.splitlines()
    assert lines[0] == "S foo bar baz"
    assert lines[1] == f"A 1 1|||ART|||-NONE-|||REQUIRED|||-NONE-|||{TEST_USER_ID}"
    assert lines[2] == f"A 2 2|||ART|||qux quux|||REQUIRED|||-NONE-|||{TEST_USER_ID}"


def test_export_handles_move_and_insert_payloads(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="alpha beta gamma", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        move_type = ErrorType(en_name="MOVE", default_color="#0ea5e9", is_active=True)
        ins_type = ErrorType(en_name="INS", default_color="#0ea5e9", is_active=True)
        session.add_all([move_type, ins_type])
        session.flush()
        session.add(
            AnnotationTask(
                text_id=text.id,
                annotator_id=TEST_USER_ID,
                status="submitted",
            )
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=TEST_USER_ID,
                start_token=0,
                end_token=0,
                replacement=None,
                error_type_id=move_type.id,
                payload={
                    "operation": "move",
                    "text_tokens": ["alpha", "beta", "gamma"],
                    "text_tokens_sha256": "hash",
                    "after_tokens": [{"id": "m1", "text": "gamma", "origin": "base"}],
                },
            )
        )
        # Represent an insertion before index 1 by using a zero-length span.
        session.add(
            Annotation(
                text_id=text.id,
                author_id=TEST_USER_ID,
                start_token=1,
                end_token=0,
                replacement=None,
                error_type_id=ins_type.id,
                payload={
                    "operation": "insert",
                    "text_tokens": ["alpha", "beta", "gamma"],
                    "text_tokens_sha256": "hash",
                    "after_tokens": [{"id": "i1", "text": "new", "origin": "inserted"}],
                },
            )
        )
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    block = next(b for b in resp.text.strip().split("\n\n") if b.startswith("S alpha beta gamma"))
    lines = block.splitlines()
    assert f"A 0 0|||MOVE|||gamma|||REQUIRED|||-NONE-|||{TEST_USER_ID}" in lines
    assert f"A 1 0|||INS|||new|||REQUIRED|||-NONE-|||{TEST_USER_ID}" in lines


def test_export_omits_non_matching_annotators_and_states(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="multi annotator", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        other_user = User(
            id=uuid.uuid4(), username="other", password_hash="x", role="annotator", is_active=True
        )
        session.add(other_user)
        err = session.query(ErrorType).first()
        session.flush()
        session.add(
            AnnotationTask(text_id=text.id, annotator_id=other_user.id, status="submitted")
        )
        session.add(
            Annotation(
                text_id=text.id,
                author_id=other_user.id,
                start_token=0,
                end_token=0,
                replacement="x",
                error_type_id=err.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["multi", "annotator"],
                    "text_tokens_sha256": "h",
                    "after_tokens": [{"id": "a1", "text": "x", "origin": "base"}],
                },
            )
        )
        # same text, but our user has not submitted
        session.add(AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    blocks = [b for b in resp.text.strip().split("\n\n") if b.strip()]
    parsed = [parse_m2_block(b) for b in blocks]
    target = next((b for b in parsed if b["tokens"] == ["multi", "annotator"]), None)
    assert target is not None
    assert any(a["label"] == "ART" and a["replacement"] == "x" for a in target["annotations"])


def test_import_export_round_trip_preserves_blocks(client):
    # Import a small M2, then export and ensure the block matches structure.
    sample_m2 = f"""S Rainy day
A 0 0|||PUNC|||Rainy|||REQUIRED|||-NONE-|||{TEST_USER_ID}
A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||{TEST_USER_ID}
"""
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        session.add(
            TextSample(content="placeholder", category_id=category.id, required_annotations=1)
        )
        session.commit()
        cat_id = category.id

    # import into a fresh category so we don't collide with earlier fixtures
    resp = client.post(
        "/api/texts/import",
        json={
            "category_id": cat_id,
            "required_annotations": 1,
            "texts": [],
            "m2_content": sample_m2,
        },
    )
    assert resp.status_code == 201, resp.text

    export_resp = client.get("/api/texts/export")
    assert export_resp.status_code == 200, export_resp.text
    blocks = [b for b in export_resp.text.strip().split("\n\n") if b.strip()]
    parsed_blocks = [parse_m2_block(b) for b in blocks]
    assert any(pb["tokens"] == ["Rainy", "day"] for pb in parsed_blocks)
    target_block = next(pb for pb in parsed_blocks if pb["tokens"] == ["Rainy", "day"])
    # Expect two annotations with noop present
    assert any(a["label"] == "noop" and a["start"] == -1 for a in target_block["annotations"])
    assert any(a["label"] == "PUNC" and a["start"] == 0 for a in target_block["annotations"])
