"""
Database workflow for submitting annotation tasks.
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import (
    Annotation,
    AnnotationTask,
    AnnotationVersion,
    CrossValidationResult,
    ErrorType,
    SkippedText,
    TextSample,
)
from .annotation_saves import sha256_text, sha256_tokens


class AnnotationSubmitError(ValueError):
    """Raised when annotations cannot be submitted."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def queue_cross_validation(*, db: Session, text_id: int) -> None:
    result = (
        db.query(CrossValidationResult)
        .filter(CrossValidationResult.text_id == text_id)
        .one_or_none()
    )
    if not result:
        result = CrossValidationResult(text_id=text_id, status="pending", result={})
        db.add(result)
    else:
        result.status = "pending"
        result.result = {}


def get_or_create_noop_error_type(db: Session) -> ErrorType:
    noop = (
        db.query(ErrorType)
        .filter(func.lower(ErrorType.en_name) == "noop")
        .one_or_none()
    )
    if noop:
        return noop
    noop = ErrorType(en_name="noop", default_color="#94a3b8", is_active=True)
    db.add(noop)
    db.flush()
    return noop


def find_unlabeled_real_annotations(annotations: list[Annotation]) -> list[Annotation]:
    return [
        ann
        for ann in annotations
        if (ann.payload or {}).get("operation") != "noop" and ann.error_type_id is None
    ]


def create_noop_annotation(db: Session, text: TextSample, author_id: Any) -> Annotation:
    text_content = text.content or ""
    tokens_snapshot = text_content.split()
    noop_type = get_or_create_noop_error_type(db)
    annotation = Annotation(
        text_id=text.id,
        author_id=author_id,
        start_token=-1,
        end_token=-1,
        replacement=None,
        error_type_id=noop_type.id,
        payload={
            "operation": "noop",
            "before_tokens": [],
            "after_tokens": [],
            "text_tokens": tokens_snapshot,
            "text_tokens_sha256": sha256_tokens(tokens_snapshot),
            "text_sha256": sha256_text(text_content),
            "source": "manual",
        },
    )
    db.add(annotation)
    db.flush()
    db.add(
        AnnotationVersion(
            annotation_id=annotation.id,
            version=annotation.version,
            snapshot={
                "start_token": annotation.start_token,
                "end_token": annotation.end_token,
                "replacement": annotation.replacement,
                "payload": annotation.payload,
                "error_type_id": annotation.error_type_id,
            },
        )
    )
    return annotation


def submit_annotation_task(db: Session, text: TextSample, author_id: Any) -> None:
    existing_annotations = (
        db.query(Annotation)
        .filter(Annotation.text_id == text.id, Annotation.author_id == author_id)
        .all()
    )
    if find_unlabeled_real_annotations(existing_annotations):
        raise AnnotationSubmitError(
            400,
            "Assign an error type to all corrections before submitting.",
        )

    task = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text.id, AnnotationTask.annotator_id == author_id)
        .one_or_none()
    )
    if not task:
        task = AnnotationTask(text_id=text.id, annotator_id=author_id, status="submitted")
        db.add(task)
    else:
        task.status = "submitted"
    task.updated_at = datetime.now(timezone.utc)

    text.locked_by_id = None
    text.locked_at = None
    (
        db.query(SkippedText)
        .filter(SkippedText.text_id == text.id, SkippedText.annotator_id == author_id)
        .delete(synchronize_session=False)
    )

    if not existing_annotations:
        create_noop_annotation(db, text, author_id)

    db.flush()
    completed_count = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text.id, AnnotationTask.status == "submitted")
        .count()
    )
    if completed_count >= text.required_annotations:
        text.state = "awaiting_cross_validation"
        queue_cross_validation(db=db, text_id=text.id)
    else:
        text.state = "pending"
    db.commit()
