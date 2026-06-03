import os
import uuid
from types import SimpleNamespace

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.models import Annotation, AnnotationVersion, Base, Category, ErrorType, TextSample, User
from app.schemas.common import AnnotationSaveRequest
from app.services.annotation_saves import ensure_payload_text_identity, save_annotation_drafts, sha256_text
from sqlalchemy.dialects.sqlite import JSON


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


def test_save_annotation_drafts_skips_matching_other_author_annotation():
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

    assert saved == []
    with db.SessionLocal() as session:
        by_self = session.query(Annotation).filter_by(author_id=AUTHOR_ID).all()
        by_other = session.query(Annotation).filter_by(author_id=other_author_id).all()
        assert by_self == []
        assert len(by_other) == 1
