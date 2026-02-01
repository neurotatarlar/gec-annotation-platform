import json
import os
import uuid
from datetime import datetime, timedelta

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


def parse_jsonl(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def test_export_includes_only_submitted(client):
    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    records = parse_jsonl(resp.text)
    assert len(records) == 1
    record = records[0]
    assert record["source"] == "hello world"
    assert record["target"] == "hi world"
    assert record["edits"]
    assert record["edits"][0]["error_type"] == "ART"
    assert "trash me" not in resp.text


def test_export_single_text_picks_latest_variant(client):
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
        session.add(
            AnnotationTask(
                text_id=text.id,
                annotator_id=TEST_USER_ID,
                status="submitted",
                updated_at=datetime.utcnow(),
            )
        )
        session.add(
            AnnotationTask(
                text_id=text.id,
                annotator_id=other_id,
                status="submitted",
                updated_at=datetime.utcnow() + timedelta(seconds=5),
            )
        )
        session.commit()

    resp = client.get(f"/api/texts/{text_id}/export")
    assert resp.status_code == 200, resp.text
    record = json.loads(resp.text.strip())
    assert record["target"] == "alpha BETA"


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
    record = next(item for item in parse_jsonl(resp.text) if item["source"] == "plain sample")
    assert record["edits"] == []
    assert record["target"] == "plain sample"


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
                    "after_tokens": [
                        {"id": "a3", "text": "qux", "origin": "base"},
                        {"id": "a4", "text": "quux", "origin": "base"},
                    ],
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
    record = next(item for item in parse_jsonl(resp.text) if item["source"] == "foo-bar baz")
    edits = record["edits"]
    assert [edit["start_token"] for edit in edits] == [1, 2]


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
                    "move_from": 2,
                    "move_to": 0,
                    "move_len": 1,
                },
            )
        )
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
    record = next(item for item in parse_jsonl(resp.text) if item["source"] == "alpha beta gamma")
    ops = {edit["operation"] for edit in record["edits"]}
    assert "move" in ops
    assert "insert" in ops


def test_export_omits_non_matching_annotators_and_states(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="multi annotator", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        other_user = User(
            id=uuid.uuid4(),
            username="other",
            password_hash="x",
            role="annotator",
            is_active=True,
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
        session.add(AnnotationTask(text_id=text.id, annotator_id=TEST_USER_ID, status="in_progress"))
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    records = parse_jsonl(resp.text)
    assert any(item["source"] == "multi annotator" for item in records)


def test_render_endpoint_returns_corrected_text(client):
    with db.SessionLocal() as session:
        text = session.query(TextSample).filter_by(content="hello world").one()
        error_type = session.query(ErrorType).first()
        assert error_type is not None
        payload = {
            "annotations": [
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": {
                        "operation": "replace",
                        "before_tokens": ["hello"],
                        "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                        "text_tokens": ["hello", "world"],
                    },
                }
            ]
        }

    resp = client.post(f"/api/texts/{text.id}/render", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["corrected_text"] == "hi world"


def test_import_export_round_trip_preserves_blocks(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        error_type = ErrorType(en_name="PUNC", default_color="#f97316", is_active=True)
        session.add(error_type)
        session.add(TextSample(content="placeholder", category_id=category.id, required_annotations=1))
        session.commit()
        cat_id = category.id
        error_type_id = error_type.id

    resp = client.post(
        "/api/texts/import",
        json={
            "category_id": cat_id,
            "required_annotations": 1,
            "texts": [
                {
                    "text": "Rainy day",
                    "annotations": [
                        {
                            "start_token": 0,
                            "end_token": 0,
                            "replacement": "Sunny",
                            "error_type_id": error_type_id,
                            "payload": {
                                "operation": "replace",
                                "text_tokens": ["Rainy", "day"],
                                "after_tokens": [
                                    {"id": "a1", "text": "Sunny", "origin": "base"}
                                ],
                            },
                        }
                    ],
                }
            ],
        },
    )
    assert resp.status_code == 201, resp.text

    export_resp = client.get("/api/texts/export")
    assert export_resp.status_code == 200, export_resp.text
    records = parse_jsonl(export_resp.text)
    record = next(item for item in records if item["source"].startswith("Rainy day"))
    assert record["edits"]
    assert any(edit["error_type"] == "PUNC" for edit in record["edits"])
