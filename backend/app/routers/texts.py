import hashlib
import logging
from datetime import datetime, timedelta, timezone
from itertools import combinations
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel

from ..models import Annotation, AnnotationTask, AnnotationVersion, Category, CrossValidationResult, SkippedText, TextSample
from ..schemas.common import (
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

router = APIRouter(prefix="/api/texts", tags=["texts"])
LOCK_DURATION = timedelta(minutes=30)
logger = logging.getLogger(__name__)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_tokens(tokens: list[str]) -> str:
    joined = "\u241f".join(tokens)  # unit separator to minimize collision with token text
    return _sha256_text(joined)


def _parse_int_list(raw: str | None) -> list[int]:
    if not raw:
        return []
    parsed: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if chunk.isdigit():
            parsed.append(int(chunk))
    return parsed


@router.post("/import", response_model=TextImportResponse, status_code=status.HTTP_201_CREATED)
def import_texts(
    request: TextImportRequest,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    category = db.get(Category, request.category_id)
    if not category:
        raise HTTPException(status_code=404, detail=f"Category with id '{request.category_id}' not found")
    normalized: list[tuple[str, str]] = []
    for item in request.texts:
        if isinstance(item, str):
            body = item
            ext_id = hashlib.sha256(body.encode("utf-8")).hexdigest()
        else:
            body = item.text
            ext_id = item.id or hashlib.sha256(body.encode("utf-8")).hexdigest()
        if not isinstance(body, str) or not body.strip():
            continue
        normalized.append((body, ext_id))

    if not normalized:
        raise HTTPException(status_code=400, detail="No texts provided")

    external_ids = [eid for _, eid in normalized if eid]
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
    for body, ext_id in normalized:
        # skip duplicates by external_id (either already in DB or repeated in payload)
        if ext_id and (ext_id in existing_ids or ext_id in seen):
            continue
        seen.add(ext_id)
        db.add(
            TextSample(
                content=body,
                external_id=ext_id,
                category_id=category.id,
                required_annotations=request.required_annotations,
            )
        )
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

    existing_task_row = (
        db.query(AnnotationTask, TextSample)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .filter(
            AnnotationTask.annotator_id == current_user.id,
            AnnotationTask.status != "submitted",
            TextSample.category_id == category_id,
            TextSample.state.in_(["pending", "in_annotation"]),
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
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return (
        db.query(Annotation)
        .filter(Annotation.text_id == text_id, Annotation.author_id == current_user.id)
        .order_by(Annotation.id)
        .all()
    )


@router.post("/{text_id}/annotations", response_model=list[AnnotationRead])
def save_annotations(
    text_id: int,
    request: AnnotationSaveRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    def _summarize_annotations(items: list[AnnotationPayload]):
        summary = []
        for ann in items[:5]:
            payload = ann.payload
            op = None
            before = None
            after = None
            text_hash = None
            if isinstance(payload, BaseModel):
                payload = payload.model_dump()
            if isinstance(payload, dict):
                op = payload.get("operation")
                before = len(payload.get("before_tokens") or [])
                after_tokens = payload.get("after_tokens") or []
                after = len(after_tokens)
                text_hash = payload.get("text_sha256") or payload.get("text_hash")
            summary.append(
                {
                    "start": ann.start_token,
                    "end": ann.end_token,
                    "op": op,
                    "before_len": before,
                    "after_len": after,
                    "hash": text_hash,
                    "has_id": getattr(ann, "id", None) is not None,
                }
            )
        return summary

    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    try:
        existing = (
            db.query(Annotation)
            .filter(Annotation.text_id == text_id, Annotation.author_id == current_user.id)
            .all()
        )
        server_version = max((ann.version for ann in existing), default=0)
        client_version = request.client_version or 0
        if client_version and client_version < server_version:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Client version is stale. Reload annotations before saving.",
            )
        text_hash = _sha256_text(text.content)

        existing_by_id = {annotation.id: annotation for annotation in existing}
        existing_by_span = {(annotation.start_token, annotation.end_token): annotation for annotation in existing}

        def _ensure_payload_dict(raw: BaseModel | dict | None) -> dict:
            if isinstance(raw, BaseModel):
                return raw.model_dump()
            return dict(raw or {})

        def _validate_payload(payload: dict):
            op = payload.get("operation")
            if op not in {"replace", "delete", "insert", "move", "noop"}:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid operation")
            after_tokens = payload.get("after_tokens", [])
            if not isinstance(after_tokens, list):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="after_tokens must be a list")
            for token in after_tokens:
                if not isinstance(token, dict):
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="after_tokens must contain objects")
                if "id" not in token or "text" not in token:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="after_tokens entries must include id and text",
                    )
                origin = token.get("origin")
                if origin not in {"base", "inserted"}:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="after_tokens origin must be 'base' or 'inserted'",
                    )
            before_tokens = payload.get("before_tokens", [])
            if not isinstance(before_tokens, list):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="before_tokens must be a list")

        saved: list[Annotation] = []
        # Process deletions first
        if request.deleted_ids:
            (
                db.query(Annotation)
                .filter(
                    Annotation.text_id == text_id,
                    Annotation.author_id == current_user.id,
                    Annotation.id.in_(request.deleted_ids),
                )
                .delete(synchronize_session=False)
            )

        for item in request.annotations:
            payload = _ensure_payload_dict(item.payload)
            _validate_payload(payload)

            payload_hash = payload.get("text_sha256")
            if payload_hash and payload_hash != text_hash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Client text hash does not match server text. Reload the text before saving.",
                )
            payload["text_sha256"] = payload_hash or text_hash
            if (
                "text_tokens" not in payload
                or not isinstance(payload.get("text_tokens"), list)
                or len(payload.get("text_tokens") or []) == 0
            ):
                tokens_snapshot = text.content.split()
                payload["text_tokens"] = tokens_snapshot
                payload["text_tokens_sha256"] = _sha256_tokens(tokens_snapshot)
            elif not payload.get("text_tokens_sha256"):
                payload["text_tokens_sha256"] = _sha256_tokens([str(t) for t in payload["text_tokens"]])

            replacement = item.replacement
            if replacement is None:
                after_tokens = payload.get("after_tokens")
                if isinstance(after_tokens, list):
                    texts: list[str] = []
                    for token in after_tokens:
                        if isinstance(token, dict):
                            texts.append(str(token.get("text", "") or ""))
                        else:
                            text_attr = getattr(token, "text", "")
                            texts.append(str(text_attr or ""))
                    candidate = " ".join(texts).strip()
                    replacement = candidate or None
            if payload.get("operation") == "noop":
                replacement = replacement or None

            annotation = None
            if item.id:
                annotation = existing_by_id.get(item.id)
            if not annotation:
                annotation = existing_by_span.get((item.start_token, item.end_token))

            if annotation:
                annotation.start_token = item.start_token
                annotation.end_token = item.end_token
                annotation.replacement = replacement
                annotation.payload = payload
                annotation.error_type_id = item.error_type_id
                annotation.version += 1
            else:
                annotation = Annotation(
                    text_id=text_id,
                    author_id=current_user.id,
                    start_token=item.start_token,
                    end_token=item.end_token,
                    replacement=replacement,
                    payload=payload,
                    error_type_id=item.error_type_id,
                )
                db.add(annotation)
            saved.append(annotation)

        db.flush()
        # Persist snapshots for rollback/history
        for ann in saved:
            snapshot = {
                "start_token": ann.start_token,
                "end_token": ann.end_token,
                "replacement": ann.replacement,
                "payload": ann.payload,
                "error_type_id": ann.error_type_id,
            }
            db.add(
                AnnotationVersion(
                    annotation_id=ann.id,
                    version=ann.version,
                    snapshot=snapshot,
                )
            )

        db.commit()
        return saved
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
                    "summary": _summarize_annotations(request.annotations),
                },
            )
        raise


@router.post("/{text_id}/submit", status_code=status.HTTP_202_ACCEPTED)
def submit_annotations(
    text_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text_id, AnnotationTask.annotator_id == current_user.id)
        .one_or_none()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Assignment not found")
    task.status = "submitted"

    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    text.locked_by_id = None
    text.locked_at = None
    # Clear any previous skip/trash markers for this annotator so the latest
    # state (submission) is exclusive going forward.
    (
        db.query(SkippedText)
        .filter(SkippedText.text_id == text_id, SkippedText.annotator_id == current_user.id)
        .delete(synchronize_session=False)
    )

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


def _resolve_label(ann: Annotation) -> str:
    if ann.error_type:
        return (
            ann.error_type.en_name
            or ann.error_type.tt_name
            or ann.error_type.category_en
            or ann.error_type.category_tt
            or "OTHER"
        )
    return "OTHER"


def _render_replacement(ann: Annotation) -> str:
    if ann.replacement:
        return ann.replacement
    payload = ann.payload or {}
    after_tokens = payload.get("after_tokens")
    if isinstance(after_tokens, list):
        texts: list[str] = []
        for token in after_tokens:
            if isinstance(token, dict):
                texts.append(str(token.get("text") or ""))
            else:
                text_val = getattr(token, "text", "") or ""
                texts.append(str(text_val))
        candidate = " ".join(texts).strip()
        if candidate:
            return candidate
    return "-NONE-"


def _build_m2_block(tokens: Iterable[str], annotations: list[Annotation]) -> str:
    base_tokens = [t for t in tokens if t is not None]
    lines = [f"S {' '.join(base_tokens)}"]
    if not annotations:
        lines.append("A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0")
        return "\n".join(lines)
    for ann in annotations:
        label = _resolve_label(ann)
        replacement = _render_replacement(ann)
        lines.append(f"A {ann.start_token} {ann.end_token}|||{label}|||{replacement}|||REQUIRED|||-NONE-|||0")
    return "\n".join(lines)


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

    tasks = task_query.order_by(AnnotationTask.updated_at.desc()).all()
    if not tasks:
        return PlainTextResponse("", media_type="text/plain")

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

    blocks: list[str] = []
    for task in tasks:
        anns = anns_by_task.get(task.id) or []
        text = task.text
        if not text:
            continue
        tokens: Iterable[str] = []
        # Prefer a saved snapshot from any annotation payload to preserve tokenization.
        snapshot = None
        for ann in anns:
            payload = ann.payload or {}
            maybe_tokens = payload.get("text_tokens")
            if isinstance(maybe_tokens, list) and maybe_tokens:
                snapshot = maybe_tokens
                break
        tokens = snapshot or text.content.split()
        if not tokens:
            continue
        blocks.append(_build_m2_block(tokens, anns))

    filename = f"export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.m2"
    return PlainTextResponse(
        "\n\n".join(blocks),
        media_type="text/plain",
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
