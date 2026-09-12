import os
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.models import Annotation, AnnotationVersion, Base, Category, ErrorType, TextSample, User
from app.schemas.common import AnnotationSaveRequest
from app.services.annotation_saves import (
    AnnotationSaveError,
    ensure_payload_text_identity,
    save_annotation_drafts,
    sha256_text,
    sha256_tokens,
)


AUTHOR_ID = uuid.uuid4()


def setup_function():
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
    ]
    Annotation.__table__.c.payload.type = JSON()
    AnnotationVersion.__table__.c.snapshot.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)


def teardown_function():
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
    ]
    Base.metadata.drop_all(bind=db.engine, tables=tables)


def seed_text(session):
    category = Category(name="SaveService")
    error_type = ErrorType(en_name="ERR", default_color="#123456", is_active=True)
    text = TextSample(content="hello world", category=category, required_annotations=1)
    session.add_all([category, error_type, text])
    session.flush()
    return text, error_type


def test_ensure_payload_text_identity_populates_missing_snapshot():
    payload = {
        "operation": "replace",
        "before_tokens": ["hello"],
        "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
    }

    ensure_payload_text_identity(payload, SimpleNamespace(content="hello world"))

    assert payload["text_sha256"] == sha256_text("hello world")
    assert payload["text_tokens"] == ["hello", "world"]
    assert payload["text_tokens_sha256"]


def test_save_annotation_drafts_creates_independent_matching_annotation():
    other_author_id = uuid.uuid4()
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        session.add(
            Annotation(
                text_id=text.id,
                author_id=other_author_id,
                start_token=0,
                end_token=0,
                replacement="hi",
                payload={
                    "operation": "replace",
                    "before_tokens": ["hello"],
                    "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                    "text_sha256": sha256_text("hello world"),
                },
                error_type_id=error_type.id,
            )
        )
        session.commit()

    with db.SessionLocal() as session:
        text = session.query(TextSample).one()
        error_type = session.query(ErrorType).one()
        request = AnnotationSaveRequest(
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": {
                        "operation": "replace",
                        "before_tokens": ["hello"],
                        "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                        "text_sha256": sha256_text("hello world"),
                    },
                }
            ],
            client_version=0,
        )

        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)

    assert len(saved) == 1
    with db.SessionLocal() as session:
        by_self = session.query(Annotation).filter_by(author_id=AUTHOR_ID).all()
        by_other = session.query(Annotation).filter_by(author_id=other_author_id).all()
        assert len(by_self) == 1
        assert len(by_other) == 1


def canonical_payload(*, correction_id="correction-1", operation="replace"):
    return {
        "schema_version": 2,
        "client_correction_id": correction_id,
        "operation": operation,
        "before_tokens": ["base-0"],
        "after_tokens": [{"id": f"{correction_id}-after", "text": "hi", "origin": "base"}],
        "text_sha256": sha256_text("hello world"),
        "text_tokens": ["hello", "world"],
        "text_tokens_sha256": sha256_tokens(["hello", "world"]),
        "source": "manual",
    }


def test_canonical_save_rejects_unstable_before_token_ids():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        payload = canonical_payload()
        payload["before_tokens"] = ["token-42"]
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": payload,
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="base-N"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)


def test_canonical_save_rejects_incomplete_move():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        payload = canonical_payload(operation="move")
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 1,
                    "end_token": 1,
                    "replacement": "hello",
                    "error_type_id": error_type.id,
                    "payload": payload,
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="move_from"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)


def test_canonical_save_rejects_render_mismatch_without_writing():
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            expected_target="different target",
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": canonical_payload(),
                }
            ],
        )

        with pytest.raises(AnnotationSaveError, match="corrected text differ"):
            save_annotation_drafts(session, text, AUTHOR_ID, request)

        assert session.query(Annotation).count() == 0


def test_canonical_full_snapshot_replaces_only_current_author_rows():
    other_author = uuid.uuid4()
    with db.SessionLocal() as session:
        text, error_type = seed_text(session)
        old = Annotation(
            text_id=text.id,
            author_id=AUTHOR_ID,
            start_token=1,
            end_token=1,
            replacement="earth",
            payload={"operation": "replace", "before_tokens": ["token-9"], "after_tokens": []},
            error_type_id=error_type.id,
        )
        foreign = Annotation(
            text_id=text.id,
            author_id=other_author,
            start_token=0,
            end_token=0,
            replacement="hey",
            payload={"operation": "replace", "before_tokens": ["token-1"], "after_tokens": []},
            error_type_id=error_type.id,
        )
        session.add_all([old, foreign])
        session.commit()
        request = AnnotationSaveRequest(
            schema_version=2,
            replace_existing=True,
            annotations=[
                {
                    "start_token": 0,
                    "end_token": 0,
                    "replacement": "hi",
                    "error_type_id": error_type.id,
                    "payload": canonical_payload(),
                }
            ],
        )

        saved = save_annotation_drafts(session, text, AUTHOR_ID, request)

    assert len(saved) == 1
    with db.SessionLocal() as session:
        own = session.query(Annotation).filter_by(author_id=AUTHOR_ID).all()
        foreign_rows = session.query(Annotation).filter_by(author_id=other_author).all()
        assert len(own) == 1
        assert own[0].replacement == "hi"
        assert own[0].payload["client_correction_id"] == "correction-1"
        assert len(foreign_rows) == 1
