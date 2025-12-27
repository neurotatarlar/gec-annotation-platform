import hashlib
import uuid

import pytest
import os
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Annotation, AnnotationVersion, Base, Category, ErrorType, TextSample, User
from sqlalchemy.dialects.sqlite import JSON
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


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture(autouse=True)
def setup_db():
    # Fresh in-memory database for each test
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
    ]
    # JSONB is not supported in SQLite; coerce to JSON for tests.
    Annotation.__table__.c.payload.type = JSON()
    AnnotationVersion.__table__.c.snapshot.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)

    # Seed user, category, text, error type
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
        text = TextSample(
            content="hello world",
            category_id=category.id,
            required_annotations=1,
        )
        session.add(text)
        et = ErrorType(
            en_name="Case",
            category_en="Grammar",
            default_color="#123456",
            is_active=True,
        )
        session.add(et)
        session.commit()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    yield

    Base.metadata.drop_all(bind=db.engine, tables=tables)
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def get_seed_ids():
    with db.SessionLocal() as session:
        text = session.query(TextSample).first()
        et = session.query(ErrorType).first()
        return text.id, et.id


def test_save_annotations_stores_snapshot_and_replacement(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 1,
                "replacement": None,
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0", "base-1"],
                    "after_tokens": [
                        {"id": "base-0", "text": "hi", "origin": "base"},
                        {"id": "ins-1", "text": "there", "origin": "inserted"},
                    ],
                    "text_sha256": sha256("hello world"),
                    "text_tokens": ["hello", "world"],
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data) == 1
    ann = data[0]
    assert ann["replacement"] == "hi there"
    assert ann["payload"]["text_sha256"] == sha256("hello world")
    assert ann["payload"]["text_tokens"] == ["hello", "world"]
    assert ann["payload"]["text_tokens_sha256"]


def test_save_annotations_does_not_delete_missing_entries_and_allows_overlap(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
        )
        session.add(ann)
        session.commit()

    payload = {
        "annotations": [
            {
                "start_token": 1,
                "end_token": 1,
                "replacement": "world",
                "error_type_id": et_id,
                "payload": {
                    "operation": "insert",
                    "before_tokens": [],
                    "after_tokens": [{"id": "ins-2", "text": "world", "origin": "inserted"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    with db.SessionLocal() as session:
        anns = session.query(Annotation).all()
        assert len(anns) == 2  # original not deleted
        spans = {(a.start_token, a.end_token) for a in anns}
        assert spans == {(0, 0), (1, 1)}


def test_save_annotations_rejects_stale_text_hash(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "hi",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "hi", "origin": "base"}],
                    "text_sha256": sha256("other text"),
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 409


def test_save_annotations_upserts_by_id_and_increments_version(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
        )
        session.add(ann)
        session.commit()
        session.refresh(ann)
        ann_id = ann.id
        ann_version = ann.version

    payload = {
        "annotations": [
            {
                "id": ann_id,
                "start_token": 0,
                "end_token": 0,
                "replacement": "new",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "new", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": ann_version,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    with db.SessionLocal() as session:
        updated = session.query(Annotation).filter_by(id=ann_id).one()
        assert updated.replacement == "new"
        assert updated.version == ann_version + 1


def test_annotation_versions_snapshot_created(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "hi",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "hi", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200
    with db.SessionLocal() as session:
        versions = session.query(AnnotationVersion).all()
        assert len(versions) == 1
        snapshot = versions[0].snapshot
        assert snapshot["replacement"] == "hi"
        assert snapshot["payload"]["operation"] == "replace"


def test_save_annotations_rejects_stale_version(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
            version=3,
        )
        session.add(ann)
        session.commit()
        session.refresh(ann)
        ann_id = ann.id

    payload = {
        "annotations": [
            {
                "id": ann_id,
                "start_token": 0,
                "end_token": 0,
                "replacement": "new",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "new", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 2,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 409


def test_save_annotations_handles_delete_move_noop_operations(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": None,
                "error_type_id": et_id,
                "payload": {
                    "operation": "delete",
                    "before_tokens": ["base-0"],
                    "after_tokens": [],
                    "text_sha256": sha256("hello world"),
                },
            },
            {
                "start_token": 1,
                "end_token": 1,
                "replacement": None,
                "error_type_id": et_id,
                "payload": {
                    "operation": "move",
                    "before_tokens": ["base-1"],
                    "after_tokens": [{"id": "base-1", "text": "world", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            },
            {
                "start_token": 2,
                "end_token": 2,
                "replacement": "unchanged",
                "error_type_id": et_id,
                "payload": {
                    "operation": "noop",
                    "before_tokens": ["base-2"],
                    "after_tokens": [{"id": "base-2", "text": "unchanged", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            },
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data) == 3
    # delete -> replacement None
    delete_ann = next(a for a in data if a["payload"]["operation"] == "delete")
    assert delete_ann["replacement"] is None
    move_ann = next(a for a in data if a["payload"]["operation"] == "move")
    assert move_ann["replacement"] == "world"
    noop_ann = next(a for a in data if a["payload"]["operation"] == "noop")
    # noop keeps replacement empty or provided value
    assert noop_ann["replacement"] in (None, "unchanged")


def test_save_annotations_validates_payload_structure(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "hi",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": "not-a-list",
                    "after_tokens": "oops",
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    # Pydantic validation should reject invalid payload structure
    assert resp.status_code in (400, 422)


def test_save_annotations_invalid_origin_rejected(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "hi",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "hi", "origin": "bogus"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    # Pydantic pre-validation can return 422; custom validation returns 400.
    assert resp.status_code in (400, 422)


def test_save_annotations_deletes_by_id(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
        )
        session.add(ann)
        session.commit()
        session.refresh(ann)
        ann_id = ann.id

    payload = {
        "annotations": [],
        "client_version": 0,
        "deleted_ids": [ann_id],
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    with db.SessionLocal() as session:
        remaining = session.query(Annotation).filter_by(text_id=text_id, author_id=TEST_USER_ID).all()
        assert len(remaining) == 0


def test_save_annotations_skips_deleted_ids_in_payload(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann1 = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old-one",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
        )
        ann2 = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=1,
            end_token=1,
            replacement="old-two",
            payload={"operation": "replace", "before_tokens": ["base-1"], "after_tokens": []},
            error_type_id=et_id,
        )
        session.add_all([ann1, ann2])
        session.commit()
        session.refresh(ann1)
        session.refresh(ann2)

    payload = {
        "annotations": [
            {
                "id": ann1.id,
                "start_token": 0,
                "end_token": 0,
                "replacement": "updated-one",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "updated-one", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            },
            {
                "id": ann2.id,
                "start_token": 1,
                "end_token": 1,
                "replacement": "updated-two",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-1"],
                    "after_tokens": [{"id": "base-1", "text": "updated-two", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            },
        ],
        "client_version": 0,
        "deleted_ids": [ann2.id],
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data) == 1
    assert data[0]["id"] == ann1.id
    assert data[0]["replacement"] == "updated-one"
    with db.SessionLocal() as session:
        remaining = (
            session.query(Annotation)
            .filter_by(text_id=text_id, author_id=TEST_USER_ID)
            .order_by(Annotation.id)
            .all()
        )
        assert [ann.id for ann in remaining] == [ann1.id]


def test_save_annotations_recreates_span_after_deletion(client):
    text_id, et_id = get_seed_ids()
    with db.SessionLocal() as session:
        ann = Annotation(
            text_id=text_id,
            author_id=TEST_USER_ID,
            start_token=0,
            end_token=0,
            replacement="old",
            payload={"operation": "replace", "before_tokens": ["base-0"], "after_tokens": []},
            error_type_id=et_id,
        )
        session.add(ann)
        session.commit()
        session.refresh(ann)
        ann_id = ann.id

    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "new",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["base-0"],
                    "after_tokens": [{"id": "base-0", "text": "new", "origin": "base"}],
                    "text_sha256": sha256("hello world"),
                },
            }
        ],
        "client_version": 0,
        "deleted_ids": [ann_id],
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data) == 1
    assert data[0]["replacement"] == "new"
    assert data[0]["version"] == 1
    with db.SessionLocal() as session:
        remaining = (
            session.query(Annotation)
            .filter_by(text_id=text_id, author_id=TEST_USER_ID)
            .order_by(Annotation.id)
            .all()
        )
        assert len(remaining) == 1
        assert remaining[0].version == 1


def test_save_annotations_populates_token_snapshot_when_missing(client):
    text_id, et_id = get_seed_ids()
    payload = {
        "annotations": [
            {
                "start_token": 0,
                "end_token": 0,
                "replacement": "hi",
                "error_type_id": et_id,
                "payload": {
                    "operation": "replace",
                    "before_tokens": ["hello"],
                    "after_tokens": [{"id": "base-0", "text": "hi", "origin": "base"}],
                    # intentionally omit text_sha256 and text_tokens to exercise server defaults
                },
            }
        ],
        "client_version": 0,
    }
    resp = client.post(f"/api/texts/{text_id}/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()[0]
    assert data["payload"]["text_tokens"] == ["hello", "world"]
    assert data["payload"]["text_tokens_sha256"]
