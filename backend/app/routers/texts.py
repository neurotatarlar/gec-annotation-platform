"""
Text and annotation workflow routes for assignment, saving, rendering, and export. Includes
import helpers, corrected-text rendering, and export formatting. Provides utilities for
normalizing payloads and token snapshots used by the editor.
"""

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from itertools import combinations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.orm.exc import StaleDataError
from pydantic import BaseModel

from ..models import (
    Annotation,
    AnnotationTask,
    AnnotationVersion,
    Category,
    CrossValidationResult,
    ErrorType,
    SkippedText,
    TextSample,
)
from ..schemas.common import (
    AnnotationRenderRequest,
    AnnotationRenderResponse,
    AnnotationPayload,
    AnnotationRead,
    AnnotationSaveRequest,
    AnnotationHistoryItem,
    CrossValidationRead,
    FlagRequest,
    FlaggedTextRead,
    TextAssignmentResponse,
    TextDiffResponse,
    TextImportRequest,
    TextImportResponse,
    TextRead,
)
from ..services.auth import get_current_user, get_db
from ..services.annotation_payloads import summarize_annotations
from ..services.annotation_rendering import build_export_record, render_corrected_text
from ..services.annotation_saves import AnnotationSaveError, save_annotation_drafts

router = APIRouter(prefix="/api/texts", tags=["texts"])
LOCK_DURATION = timedelta(minutes=30)
logger = logging.getLogger(__name__)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_tokens(tokens: list[str]) -> str:
    joined = "\u241f".join(tokens)  # unit separator to minimize collision with token text
    return _sha256_text(joined)


def _get_or_create_noop_error_type(db: Session) -> ErrorType:
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


def _parse_int_list(raw: str | None) -> list[int]:
    if not raw:
        return []
    parsed: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if chunk.isdigit():
            parsed.append(int(chunk))
    return parsed


def _annotation_payload_to_dict(item: AnnotationPayload | dict) -> dict:
    if isinstance(item, BaseModel):
        data = item.model_dump()
    else:
        data = dict(item)
    payload = data.get("payload")
    if isinstance(payload, BaseModel):
        data["payload"] = payload.model_dump()
    elif payload is None:
        data["payload"] = {}
    return data


@router.post("/import", response_model=TextImportResponse, status_code=status.HTTP_201_CREATED)
def import_texts(
    request: TextImportRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    category = db.get(Category, request.category_id)
    if not category:
        raise HTTPException(status_code=404, detail=f"Category with id '{request.category_id}' not found")

    normalized: list[dict[str, object]] = []

    def _append_normalized(body: str, ext_id: str | None, annotations: list[dict] | None = None):
        if not isinstance(body, str) or not body.strip():
            return
        normalized.append({"body": body, "ext_id": ext_id, "annotations": annotations or []})

    for item in request.texts:
        if isinstance(item, str):
            body = item
            ext_id = hashlib.sha256(body.encode("utf-8")).hexdigest()
            annotations = None
        else:
            body = item.text
            ext_id = item.id or hashlib.sha256(body.encode("utf-8")).hexdigest()
            annotations = item.annotations
        _append_normalized(body, ext_id, annotations)

    if not normalized:
        raise HTTPException(status_code=400, detail="No texts provided")

    external_ids = [str(entry["ext_id"]) for entry in normalized if entry.get("ext_id")]
    existing_ids: set[str] = set()
    if external_ids:
        rows = (
            db.query(TextSample.external_id)
            .filter(TextSample.category_id == category.id, TextSample.external_id.in_(external_ids))
            .all()
        )
        existing_ids = {row[0] for row in rows if row[0]}

    seen: set[str] = set()
    inserted = 0
    for entry in normalized:
        body = entry["body"]
        ext_id = entry.get("ext_id")
        ext_id_value = str(ext_id) if ext_id is not None else None
        annotations = entry.get("annotations") or []
        # skip duplicates by external_id (either already in DB or repeated in payload)
        if ext_id and (ext_id in existing_ids or ext_id in seen):
            continue
        if ext_id:
            seen.add(ext_id)
        text = TextSample(
            content=body,
            external_id=ext_id_value,  # type: ignore[arg-type]
            category_id=category.id,
            required_annotations=request.required_annotations,
        )
        db.add(text)
        db.flush()
        if annotations:
            task = AnnotationTask(text_id=text.id, annotator_id=current_user.id, status="submitted")
            db.add(task)
            for item in annotations:
                item_data = _annotation_payload_to_dict(item)
                payload = item_data.get("payload") or {}
                db.add(
                    Annotation(
                        text_id=text.id,
                        author_id=current_user.id,
                        start_token=item_data.get("start_token", 0),
                        end_token=item_data.get("end_token", 0),
                        replacement=item_data.get("replacement"),
                        error_type_id=item_data.get("error_type_id"),
                        payload=payload,
                    )
                )
            completed_count = (
                db.query(AnnotationTask)
                .filter(AnnotationTask.text_id == text.id, AnnotationTask.status == "submitted")
                .count()
            )
            if completed_count >= text.required_annotations:
                text.state = "awaiting_cross_validation"
                _queue_cross_validation(db=db, text_id=text.id)
            else:
                text.state = "pending"
        inserted += 1
    db.commit()
    return TextImportResponse(inserted=inserted)


@router.post("/assignments/next", response_model=TextAssignmentResponse)
def get_next_text(
    category_id: int = Query(..., description="Category identifier"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    category = db.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail=f"Category with id '{category_id}' not found")

    now = datetime.now(timezone.utc)
    # release expired locks
    db.query(TextSample).filter(
        TextSample.locked_at.isnot(None), TextSample.locked_at < now - LOCK_DURATION
    ).update(
        {TextSample.locked_by_id: None, TextSample.locked_at: None}, synchronize_session=False
    )

    skipped_subquery = select(SkippedText.text_id).where(SkippedText.annotator_id == current_user.id)
    any_task_for_user = select(AnnotationTask.text_id).where(AnnotationTask.annotator_id == current_user.id)
    submitted_subquery = select(AnnotationTask.text_id).where(
        AnnotationTask.annotator_id == current_user.id, AnnotationTask.status == "submitted"
    )

    terminal_statuses = ("submitted", "skip", "trash")
    terminal_texts_subq = select(AnnotationTask.text_id).where(AnnotationTask.status.in_(terminal_statuses))

    existing_task_row = (
        db.query(AnnotationTask, TextSample)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .filter(
            AnnotationTask.annotator_id == current_user.id,
            AnnotationTask.status.notin_(terminal_statuses),
            TextSample.category_id == category_id,
            TextSample.state.in_(["pending", "in_annotation"]),
            ~AnnotationTask.text_id.in_(skipped_subquery),
            ~TextSample.id.in_(terminal_texts_subq),
        )
        .order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc())
        .with_for_update(skip_locked=True)
        .first()
    )

    if existing_task_row:
        task, text = existing_task_row
        text.locked_by_id = current_user.id
        text.locked_at = now
        text.state = "in_annotation"
        if task.status != "in_progress":
            task.status = "in_progress"

        annotations = (
            db.query(Annotation)
            .filter(Annotation.text_id == text.id, Annotation.author_id == current_user.id)
            .all()
        )
        db.commit()
        return TextAssignmentResponse(text=text, annotations=annotations, lock_expires_at=now + LOCK_DURATION)

    submitted_count_subq = (
        select(func.count())
        .select_from(AnnotationTask)
        .where(AnnotationTask.text_id == TextSample.id, AnnotationTask.status == "submitted")
        .correlate(TextSample)
        .scalar_subquery()
    )

    stmt = (
        select(TextSample)
        .where(
            TextSample.category_id == category_id,
            TextSample.state.in_(["pending", "in_annotation"]),
            ~TextSample.id.in_(skipped_subquery),
            ~TextSample.id.in_(any_task_for_user),
            ~TextSample.id.in_(submitted_subquery),
            ~TextSample.id.in_(terminal_texts_subq),
            or_(
                TextSample.locked_by_id.is_(None),
                TextSample.locked_by_id == current_user.id,
            ),
            submitted_count_subq < TextSample.required_annotations,
        )
        .order_by(TextSample.id)
        .with_for_update(skip_locked=True)
    )
    text = db.execute(stmt).scalars().first()
    if not text:
        raise HTTPException(status_code=404, detail="No texts available in this category")

    text.locked_by_id = current_user.id
    text.locked_at = now
    text.state = "in_annotation"
    db.flush()

    task = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text.id, AnnotationTask.annotator_id == current_user.id)
        .one_or_none()
    )
    if not task:
        task = AnnotationTask(text_id=text.id, annotator_id=current_user.id)
        db.add(task)
        db.flush()

    annotations = (
        db.query(Annotation)
        .filter(Annotation.text_id == text.id, Annotation.author_id == current_user.id)
        .all()
    )
    db.commit()
    return TextAssignmentResponse(text=text, annotations=annotations, lock_expires_at=now + LOCK_DURATION)


@router.get("/{text_id}/annotations", response_model=list[AnnotationRead])
def list_annotations(
    text_id: int,
    all_authors: bool = Query(False, description="Include annotations from all annotators"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    query = db.query(Annotation).filter(Annotation.text_id == text_id)
    if not all_authors:
        query = query.filter(Annotation.author_id == current_user.id)
    return query.order_by(Annotation.id).all()


@router.post("/{text_id}/render", response_model=AnnotationRenderResponse)
def render_annotations(
    text_id: int,
    request: AnnotationRenderRequest,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")
    corrected = render_corrected_text(text.content or "", request.annotations)
    return AnnotationRenderResponse(corrected_text=corrected)


@router.post("/{text_id}/annotations", response_model=list[AnnotationRead])
def save_annotations(
    text_id: int,
    request: AnnotationSaveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    try:
        return save_annotation_drafts(db, text, current_user.id, request)
    except StaleDataError:
        db.rollback()
        logger.warning(
            "Annotation save conflict",
            extra={
                "text_id": text_id,
                "user_id": str(getattr(current_user, "id", "")),
                "client_version": request.client_version,
                "count": len(request.annotations),
                "summary": summarize_annotations(request.annotations),
            },
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Annotations changed on the server. Reload and try again.",
        )
    except AnnotationSaveError as exc:
        db.rollback()
        if exc.status_code in {400, 409, 422}:
            logger.warning(
                "Annotation save failed",
                extra={
                    "text_id": text_id,
                    "user_id": str(getattr(current_user, "id", "")),
                    "status": exc.status_code,
                    "detail": exc.detail,
                    "client_version": request.client_version,
                    "count": len(request.annotations),
                    "summary": summarize_annotations(request.annotations),
                },
            )
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except HTTPException as exc:
        if exc.status_code in {400, 409, 422}:
            logger.warning(
                "Annotation save failed",
                extra={
                    "text_id": text_id,
                    "user_id": str(getattr(current_user, "id", "")),
                    "status": exc.status_code,
                    "detail": exc.detail,
                    "client_version": request.client_version,
                    "count": len(request.annotations),
                    "summary": summarize_annotations(request.annotations),
                },
            )
        raise


@router.post("/{text_id}/submit", status_code=status.HTTP_202_ACCEPTED)
def submit_annotations(
    text_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    task = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text_id, AnnotationTask.annotator_id == current_user.id)
        .one_or_none()
    )
    if not task:
        task = AnnotationTask(text_id=text_id, annotator_id=current_user.id, status="submitted")
        db.add(task)
    else:
        task.status = "submitted"
    task.updated_at = datetime.now(timezone.utc)

    text.locked_by_id = None
    text.locked_at = None
    # Clear any previous skip/trash markers for this annotator so the latest
    # state (submission) is exclusive going forward.
    (
        db.query(SkippedText)
        .filter(SkippedText.text_id == text_id, SkippedText.annotator_id == current_user.id)
        .delete(synchronize_session=False)
    )

    existing_annotations = (
        db.query(Annotation)
        .filter(Annotation.text_id == text_id, Annotation.author_id == current_user.id)
        .all()
    )
    unlabeled_annotations = [
        ann
        for ann in existing_annotations
        if (ann.payload or {}).get("operation") != "noop" and ann.error_type_id is None
    ]
    if unlabeled_annotations:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Assign an error type to all corrections before submitting.",
        )
    if not existing_annotations:
        tokens_snapshot = text.content.split()
        noop_type = _get_or_create_noop_error_type(db)
        payload = {
            "operation": "noop",
            "before_tokens": [],
            "after_tokens": [],
            "text_tokens": tokens_snapshot,
            "text_tokens_sha256": _sha256_tokens(tokens_snapshot),
            "text_sha256": _sha256_text(text.content),
            "source": "manual",
        }
        annotation = Annotation(
            text_id=text_id,
            author_id=current_user.id,
            start_token=-1,
            end_token=-1,
            replacement=None,
            error_type_id=noop_type.id,
            payload=payload,
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

    db.flush()
    completed_count = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text_id, AnnotationTask.status == "submitted")
        .count()
    )
    if completed_count >= text.required_annotations:
        text.state = "awaiting_cross_validation"
        _queue_cross_validation(db=db, text_id=text_id)
    else:
        # Return the text to the queue for other annotators if more submissions are needed.
        text.state = "pending"
    db.commit()
    return {"status": "submitted"}


def _flag_text(
    text_id: int,
    flag_type: str,
    payload: FlagRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
) -> None:
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    # Remove opposite flag types for this user/text to keep the latest flag exclusive.
    (
        db.query(SkippedText)
        .filter(
            SkippedText.text_id == text_id,
            SkippedText.annotator_id == current_user.id,
            SkippedText.flag_type != flag_type,
        )
        .delete(synchronize_session=False)
    )

    skip = (
        db.query(SkippedText)
        .filter(
            SkippedText.text_id == text_id,
            SkippedText.annotator_id == current_user.id,
            SkippedText.flag_type == flag_type,
        )
        .one_or_none()
    )
    if skip:
        skip.reason = payload.reason
        skip.flag_type = flag_type
    else:
        skip = SkippedText(
            text_id=text_id,
            annotator_id=current_user.id,
            reason=payload.reason,
            flag_type=flag_type,
        )
        db.add(skip)

    if text.locked_by_id == current_user.id:
        text.locked_by_id = None
        text.locked_at = None

    task = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text_id, AnnotationTask.annotator_id == current_user.id)
        .one_or_none()
    )
    if task:
        task.status = flag_type
        task.updated_at = datetime.now(timezone.utc)

    # Make the text unavailable for further assignment until restored.
    text.locked_by_id = None
    text.locked_at = None
    if flag_type == "trash":
        text.state = "trash"
    else:  # skip
        text.state = "skipped"

    db.commit()


def _clear_flag(
    text_id: int,
    flag_type: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
) -> None:
    skip = (
        db.query(SkippedText)
        .filter(
            SkippedText.text_id == text_id,
            SkippedText.annotator_id == current_user.id,
            SkippedText.flag_type == flag_type,
        )
        .one_or_none()
    )
    if skip:
        text = db.get(TextSample, text_id)
        if text:
            if flag_type == "trash":
                text.state = "pending"
            else:
                remaining = (
                    db.query(SkippedText)
                    .filter(SkippedText.text_id == text_id, SkippedText.flag_type == "skip")
                    .count()
                )
                if remaining == 1:  # current row will be removed below
                    text.state = "pending"
        db.delete(skip)
        db.commit()


@router.post("/{text_id}/skip", status_code=status.HTTP_204_NO_CONTENT)
def skip_text(
    text_id: int,
    payload: FlagRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _flag_text(text_id, "skip", payload, db, current_user)


@router.post("/{text_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
def trash_text(
    text_id: int,
    payload: FlagRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _flag_text(text_id, "trash", payload, db, current_user)


@router.delete("/{text_id}/skip", status_code=status.HTTP_204_NO_CONTENT)
def unskip_text(
    text_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _clear_flag(text_id, "skip", db, current_user)


@router.delete("/{text_id}/trash", status_code=status.HTTP_204_NO_CONTENT)
def untrash_text(
    text_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _clear_flag(text_id, "trash", db, current_user)


def _fetch_flagged(db: Session, user, flag_type: str):
    return (
        db.query(SkippedText)
        .join(SkippedText.text)
        .filter(SkippedText.annotator_id == user.id, SkippedText.flag_type == flag_type)
        .order_by(SkippedText.created_at.desc())
        .all()
    )


@router.get("/flags", response_model=list[FlaggedTextRead])
def list_flagged_texts(
    flag_type: str = Query("skip"),
    category_id: int | None = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    query = (
        db.query(SkippedText)
        .join(SkippedText.text)
        .filter(SkippedText.annotator_id == current_user.id, SkippedText.flag_type == flag_type)
    )
    if category_id is not None:
        query = query.filter(TextSample.category_id == category_id)
    return query.order_by(SkippedText.created_at.desc()).all()


@router.get("/skipped", response_model=list[FlaggedTextRead])
def list_skipped_texts(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return _fetch_flagged(db, current_user, "skip")


@router.get("/history", response_model=list[AnnotationHistoryItem])
def list_annotation_history(
    limit: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    rows = (
        db.query(AnnotationTask, TextSample)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .filter(AnnotationTask.annotator_id == current_user.id)
        .order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc())
        .limit(limit)
        .all()
    )
    history: list[AnnotationHistoryItem] = []
    for task, text in rows:
        preview = (text.content or "")[:160]
        history.append(
            AnnotationHistoryItem(
                text_id=text.id,
                status=task.status,
                updated_at=task.updated_at or datetime.utcnow(),
                preview=preview,
            )
        )
    return history



def _fetch_annotations_for_tasks(
    db: Session,
    tasks: list[AnnotationTask],
) -> dict[int, list[Annotation]]:
    if not tasks:
        return {}
    task_ids = [task.id for task in tasks]
    ann_rows = (
        db.query(Annotation, AnnotationTask.id)
        .join(AnnotationTask, AnnotationTask.text_id == Annotation.text_id)
        .filter(AnnotationTask.id.in_(task_ids), Annotation.author_id == AnnotationTask.annotator_id)
        .options(joinedload(Annotation.error_type))
        .all()
    )
    anns_by_task: dict[int, list[Annotation]] = {task.id: [] for task in tasks}
    for ann, task_id in ann_rows:
        anns_by_task.setdefault(task_id, []).append(ann)
    return anns_by_task


@router.get("/{text_id}/export", response_class=PlainTextResponse)
def export_single_text(
    text_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    task_query = (
        db.query(AnnotationTask)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .options(joinedload(AnnotationTask.text))
        .filter(AnnotationTask.text_id == text_id)
        .filter(AnnotationTask.status == "submitted")
        .filter(TextSample.state.notin_(["trash", "skipped"]))
    )
    tasks = task_query.order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc()).all()
    if not tasks:
        return PlainTextResponse("", media_type="application/x-jsonlines")

    anns_by_task = _fetch_annotations_for_tasks(db, tasks)
    text = tasks[0].text
    if not text:
        return PlainTextResponse("", media_type="application/x-jsonlines")

    variants: list[dict] = []
    for task in tasks:
        annotations = anns_by_task.get(task.id) or []
        variants.append(build_export_record(text, annotations))

    chosen = variants[0]
    if len({record["target"] for record in variants}) == 1 and variants:
        chosen = variants[0]

    payload = json.dumps(chosen, ensure_ascii=False)
    return PlainTextResponse(payload, media_type="application/x-jsonlines")


@router.get("/export", response_class=PlainTextResponse)
def export_submitted_texts(
    category_ids: str | None = Query(None, description="Comma-separated category ids"),
    start: datetime | None = Query(None, description="Start datetime (inclusive)"),
    end: datetime | None = Query(None, description="End datetime (inclusive)"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    categories = _parse_int_list(category_ids)
    task_query = (
        db.query(AnnotationTask)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .options(joinedload(AnnotationTask.text))
        .filter(AnnotationTask.status == "submitted")
        .filter(TextSample.state.notin_(["trash", "skipped"]))
    )
    if categories:
        task_query = task_query.filter(TextSample.category_id.in_(categories))
    if start:
        task_query = task_query.filter(AnnotationTask.updated_at >= start)
    if end:
        task_query = task_query.filter(AnnotationTask.updated_at <= end)

    tasks = task_query.order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc()).all()
    if not tasks:
        return PlainTextResponse("", media_type="application/x-jsonlines")

    anns_by_task = _fetch_annotations_for_tasks(db, tasks)
    tasks_by_text: dict[int, list[AnnotationTask]] = {}
    for task in tasks:
        tasks_by_text.setdefault(task.text_id, []).append(task)

    records: list[str] = []
    for text_id, text_tasks in tasks_by_text.items():
        text = text_tasks[0].text
        if not text:
            continue
        variants: list[dict] = []
        for task in text_tasks:
            annotations = anns_by_task.get(task.id) or []
            variants.append(build_export_record(text, annotations))
        chosen = variants[0]
        if len({record["target"] for record in variants}) == 1 and variants:
            chosen = variants[0]
        records.append(json.dumps(chosen, ensure_ascii=False))

    filename = f"export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.jsonl"
    return PlainTextResponse(
        "\n".join(records),
        media_type="application/x-jsonlines",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{text_id}", response_model=TextRead)
def get_text(text_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")
    return text


def _queue_cross_validation(*, db: Session, text_id: int):
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


@router.get("/{text_id}/cross-validation", response_model=CrossValidationRead)
def get_cross_validation_status(
    text_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    result = (
        db.query(CrossValidationResult)
        .filter(CrossValidationResult.text_id == text_id)
        .one_or_none()
    )
    if not result:
        return CrossValidationRead(
            text_id=text_id,
            status="not_started",
            result={},
            updated_at=datetime.now(timezone.utc),
        )
    return result


@router.get("/{text_id}/diffs", response_model=TextDiffResponse)
def get_annotation_diffs(
    text_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    annotations = db.query(Annotation).filter(Annotation.text_id == text_id).all()
    if not annotations:
        return TextDiffResponse(text_id=text_id, pairs=[])

    grouped: dict[str, list[Annotation]] = {}
    for annotation in annotations:
        grouped.setdefault(str(annotation.author_id), []).append(annotation)

    diffs = []
    for left_id, right_id in combinations(grouped.keys(), 2):
        left_set = {
            (
                ann.start_token,
                ann.end_token,
                ann.replacement,
                ann.error_type_id,
            )
            for ann in grouped[left_id]
        }
        right_set = {
            (
                ann.start_token,
                ann.end_token,
                ann.replacement,
                ann.error_type_id,
            )
            for ann in grouped[right_id]
        }
        diffs.append(
            {
                "pair": [left_id, right_id],
                "only_left": list(left_set - right_set),
                "only_right": list(right_set - left_set),
            }
        )

    return TextDiffResponse(text_id=text_id, pairs=diffs)
