import os
import uuid

import pytest
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.models import (
    Annotation,
    AnnotationTask,
    AnnotationVersion,
    Base,
    Category,
    CrossValidationResult,
    ErrorType,
    SkippedText,
    TextSample,
    User,
)
from app.services.annotation_submissions import AnnotationSubmitError, submit_annotation_task


AUTHOR_ID = uuid.uuid4()


def setup_function():
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        AnnotationTask.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
        SkippedText.__table__,
        CrossValidationResult.__table__,
    ]
    Annotation.__table__.c.payload.type = JSON()
    AnnotationVersion.__table__.c.snapshot.type = JSON()
    CrossValidationResult.__table__.c.result.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)


def teardown_function():
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        AnnotationTask.__table__,
        ErrorType.__table__,
        Annotation.__table__,
        AnnotationVersion.__table__,
        SkippedText.__table__,
        CrossValidationResult.__table__,
    ]
    Base.metadata.drop_all(bind=db.engine, tables=tables)


def seed_text(session, *, required_annotations: int = 1):
    category = Category(name="SubmitService")
    text = TextSample(content="hello world", category=category, required_annotations=required_annotations)
    session.add_all([category, text])
    session.flush()
    return text


def test_submit_annotation_task_rejects_unlabeled_real_correction():
    with db.SessionLocal() as session:
        text = seed_text(session)
        session.add(
            Annotation(
                text_id=text.id,
                author_id=AUTHOR_ID,
                start_token=0,
                end_token=0,
                replacement="hi",
                error_type_id=None,
                payload={"operation": "replace", "before_tokens": ["hello"], "after_tokens": []},
            )
        )
        session.commit()

    with db.SessionLocal() as session:
        text = session.query(TextSample).one()

        with pytest.raises(AnnotationSubmitError) as exc_info:
            submit_annotation_task(session, text, AUTHOR_ID)

        assert exc_info.value.status_code == 400
        assert exc_info.value.detail == "Assign an error type to all corrections before submitting."

    with db.SessionLocal() as session:
        assert session.query(AnnotationTask).count() == 0


def test_submit_annotation_task_creates_noop_and_queues_cross_validation():
    with db.SessionLocal() as session:
        text = seed_text(session)
        session.add(
            SkippedText(
                text_id=text.id,
                annotator_id=AUTHOR_ID,
                reason="later",
                flag_type="skip",
            )
        )
        session.commit()

    with db.SessionLocal() as session:
        text = session.query(TextSample).one()

        submit_annotation_task(session, text, AUTHOR_ID)

    with db.SessionLocal() as session:
        task = session.query(AnnotationTask).one()
        annotation = session.query(Annotation).one()
        version = session.query(AnnotationVersion).one()
        cv = session.query(CrossValidationResult).one()
        text = session.query(TextSample).one()

        assert task.status == "submitted"
        assert annotation.payload["operation"] == "noop"
        assert annotation.payload["text_tokens"] == ["hello", "world"]
        assert version.snapshot["payload"]["operation"] == "noop"
        assert session.query(SkippedText).count() == 0
        assert text.state == "awaiting_cross_validation"
        assert cv.status == "pending"
