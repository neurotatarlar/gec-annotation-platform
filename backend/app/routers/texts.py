"""
Text and annotation workflow routes for assignment, saving, rendering, and export. Includes
import helpers, corrected-text rendering, and export formatting. Provides utilities for
normalizing payloads and token snapshots used by the editor.
"""

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from itertools import combinations
from typing import Iterable

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
    corrected = _render_corrected_text(text.content or "", request.annotations)
    return AnnotationRenderResponse(corrected_text=corrected)


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

        def _normalize_token_fragment(token: object) -> tuple:
            if isinstance(token, dict):
                return (
                    str(token.get("id")) if token.get("id") is not None else None,
                    str(token.get("text") or ""),
                    token.get("origin"),
                    token.get("space_before", token.get("spaceBefore")),
                    token.get("source_id", token.get("sourceId")),
                )
            return (
                str(getattr(token, "id", None)) if getattr(token, "id", None) is not None else None,
                str(getattr(token, "text", "") or ""),
                getattr(token, "origin", None),
                getattr(token, "space_before", getattr(token, "spaceBefore", None)),
                getattr(token, "source_id", getattr(token, "sourceId", None)),
            )

        def _payload_signature(payload: dict, replacement: str | None) -> tuple:
            op = payload.get("operation") or ("replace" if replacement else "noop")
            before_tokens = payload.get("before_tokens")
            if not isinstance(before_tokens, list):
                before_tokens = []
            after_tokens = payload.get("after_tokens")
            if not isinstance(after_tokens, list):
                after_tokens = []
            move_from = payload.get("move_from", payload.get("moveFrom"))
            move_to = payload.get("move_to", payload.get("moveTo"))
            move_len = payload.get("move_len", payload.get("moveLen"))
            return (
                op,
                tuple(str(tok) for tok in before_tokens),
                tuple(_normalize_token_fragment(tok) for tok in after_tokens),
                move_from,
                move_to,
                move_len,
            )

        saved: list[Annotation] = []
        deleted_ids = set(request.deleted_ids or [])
        # Process deletions first
        if deleted_ids:
            (
                db.query(Annotation)
                .filter(
                    Annotation.text_id == text_id,
                    Annotation.id.in_(deleted_ids),
                )
                .delete(synchronize_session=False)
            )
            existing = [ann for ann in existing if ann.id not in deleted_ids]

        # Refresh mappings after deletions so we don't upsert against removed rows.
        if deleted_ids:
            existing = (
                db.query(Annotation)
                .filter(Annotation.text_id == text_id, Annotation.author_id == current_user.id)
                .all()
            )
        existing_by_id = {annotation.id: annotation for annotation in existing}
        existing_by_span = {(annotation.start_token, annotation.end_token): annotation for annotation in existing}
        other_existing = (
            db.query(Annotation)
            .filter(Annotation.text_id == text_id, Annotation.author_id != current_user.id)
            .all()
        )
        other_by_id = {annotation.id: annotation for annotation in other_existing}
        other_by_span: dict[tuple[int, int], list[Annotation]] = {}
        for annotation in other_existing:
            other_by_span.setdefault((annotation.start_token, annotation.end_token), []).append(annotation)
        for group in other_by_span.values():
            group.sort(key=lambda ann: ann.id)

        for item in request.annotations:
            if item.id and item.id in deleted_ids:
                continue
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

            def _annotation_matches(
                candidate: Annotation,
                expected_sig: tuple,
                expected_replacement: str | None,
                expected_error_type: int,
            ) -> bool:
                if (candidate.replacement or None) != (expected_replacement or None):
                    return False
                if candidate.error_type_id != expected_error_type:
                    return False
                candidate_payload = _ensure_payload_dict(candidate.payload)
                candidate_sig = _payload_signature(candidate_payload, candidate.replacement)
                return candidate_sig == expected_sig

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
                saved.append(annotation)
            else:
                payload_sig = _payload_signature(payload, replacement)
                other_annotation = other_by_id.get(item.id) if item.id else None
                if not other_annotation:
                    candidates = other_by_span.get((item.start_token, item.end_token), [])
                    if candidates:
                        match = next(
                            (
                                candidate
                                for candidate in candidates
                                if _annotation_matches(candidate, payload_sig, replacement, item.error_type_id)
                            ),
                            None,
                        )
                        if match:
                            continue
                        other_annotation = candidates[0]
                if other_annotation:
                    if _annotation_matches(other_annotation, payload_sig, replacement, item.error_type_id):
                        continue
                    other_annotation.author_id = current_user.id
                    other_annotation.start_token = item.start_token
                    other_annotation.end_token = item.end_token
                    other_annotation.replacement = replacement
                    other_annotation.payload = payload
                    other_annotation.error_type_id = item.error_type_id
                    other_annotation.version += 1
                    annotation = other_annotation
                    existing_by_id[annotation.id] = annotation
                    existing_by_span[(annotation.start_token, annotation.end_token)] = annotation
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
    except StaleDataError:
        db.rollback()
        logger.warning(
            "Annotation save conflict",
            extra={
                "text_id": text_id,
                "user_id": str(getattr(current_user, "id", "")),
                "client_version": request.client_version,
                "count": len(request.annotations),
                "summary": _summarize_annotations(request.annotations),
            },
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Annotations changed on the server. Reload and try again.",
        )
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


_SPECIAL_TOKEN_SOURCES = [
    r"\+\d[\d()\- ]*\d",
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    r"(https?:\/\/[^\s,;:!]+|www\.[^\s,;:!]+)",
]
_SPECIAL_TOKEN_FULL = [re.compile(rf"^{src}$") for src in _SPECIAL_TOKEN_SOURCES]
_SPECIAL_TOKEN_MATCHERS = [re.compile(src) for src in _SPECIAL_TOKEN_SOURCES]
_BASE_REGEX = re.compile(r"(\w+)|[^\w\s]", re.UNICODE)


def _is_punct_only(value: str) -> bool:
    return bool(value) and all(not ch.isalnum() for ch in value)


def _is_special_token(value: str) -> bool:
    trimmed = re.sub(r"[.,;:!?]+$", "", value or "")
    if not trimmed:
        return False
    return any(regex.match(trimmed) for regex in _SPECIAL_TOKEN_FULL)


def _tokenize_to_tokens(text: str) -> list[dict]:
    tokens: list[dict] = []
    if not text:
        return tokens
    idx = 0
    while idx < len(text):
        had_space = False
        while idx < len(text) and text[idx].isspace():
            had_space = True
            idx += 1
        if idx >= len(text):
            break
        matched = False
        for matcher in _SPECIAL_TOKEN_MATCHERS:
            res = matcher.match(text, idx)
            if not res:
                continue
            raw = res.group(0)
            value = re.sub(r"[.,;:!?]+$", "", raw)
            advance_by = len(value) or len(raw)
            if value:
                tokens.append(
                    {
                        "text": value,
                        "kind": "special",
                        "space_before": False if not tokens else had_space,
                    }
                )
            idx += advance_by
            matched = True
            break
        if matched:
            continue
        base_match = _BASE_REGEX.match(text, idx)
        if base_match:
            value = base_match.group(0)
            tokens.append(
                {
                    "text": value,
                    "kind": "punct" if _is_punct_only(value) else "word",
                    "space_before": False if not tokens else had_space,
                }
            )
            idx += len(value)
            continue
        idx += 1
    return tokens


def _compute_line_breaks(text: str) -> list[int]:
    breaks: list[int] = []
    if not text:
        return breaks
    lines = text.split("\n")
    count = 0
    for idx, line in enumerate(lines):
        line_tokens = _tokenize_to_tokens(line)
        count += len(line_tokens)
        if idx < len(lines) - 1:
            breaks.append(count)
    return breaks


def _build_tokens_from_snapshot(snapshot: list[str], source_text: str) -> list[dict]:
    tokens: list[dict] = []
    cursor = 0
    for idx, text in enumerate(snapshot):
        has_space = False
        while cursor < len(source_text) and source_text[cursor].isspace():
            has_space = True
            cursor += 1
        next_index = source_text.find(text, cursor) if text else -1
        if next_index > cursor:
            chunk = source_text[cursor:next_index]
            if any(ch.isspace() for ch in chunk):
                has_space = True
            cursor = next_index
        kind = "special" if _is_special_token(text) else "punct" if _is_punct_only(text) else "word"
        tokens.append(
            {
                "text": text,
                "kind": kind,
                "space_before": False if idx == 0 else has_space,
            }
        )
        if next_index >= 0:
            cursor = next_index + len(text)
    return tokens


def _resolve_tokens_snapshot_for_source(source: str, annotations: Iterable[object]) -> list[dict]:
    snapshot: list[str] | None = None
    for ann in annotations:
        payload = _coerce_payload(getattr(ann, "payload", None))
        maybe_tokens = payload.get("text_tokens")
        if isinstance(maybe_tokens, list) and maybe_tokens:
            snapshot = [str(token) for token in maybe_tokens if token is not None]
            break
    if snapshot:
        return _build_tokens_from_snapshot(snapshot, source)
    return _tokenize_to_tokens(source)


def _resolve_tokens_snapshot(text: TextSample, annotations: list[Annotation]) -> list[dict]:
    return _resolve_tokens_snapshot_for_source(text.content or "", annotations)


def _tokenize_edited_text(text: str) -> list[dict]:
    tokens: list[dict] = []
    if not text:
        return tokens
    parts = re.split(r"(\s+)", text)
    space_before = False
    for part in parts:
        if not part:
            continue
        if part.isspace():
            space_before = True
            continue
        tokens.append(
            {
                "text": part,
                "kind": "punct" if _is_punct_only(part) else "word",
                "space_before": space_before,
            }
        )
        space_before = False
    return tokens


def _build_tokens_from_fragments(
    fragments: list[dict],
    fallback_text: str,
    default_first_space: bool | None,
) -> list[dict]:
    built: list[dict] = []
    base_fragments = fragments if fragments else ([{"text": fallback_text}] if fallback_text else [])
    for frag_index, frag in enumerate(base_fragments):
        text = frag.get("text") if isinstance(frag, dict) else str(frag)
        if not text:
            continue
        explicit_space = None
        if isinstance(frag, dict):
            if isinstance(frag.get("space_before"), bool):
                explicit_space = frag.get("space_before")
            if isinstance(frag.get("spaceBefore"), bool):
                explicit_space = frag.get("spaceBefore")
        base_tokens = _tokenize_edited_text(text)
        for idx, tok in enumerate(base_tokens):
            space_before = tok["space_before"]
            if idx == 0:
                if explicit_space is not None:
                    space_before = explicit_space
                elif frag_index > 0:
                    space_before = False if tok["kind"] == "punct" else True
                elif default_first_space is not None:
                    space_before = default_first_space
            if idx == 0 and frag_index > 0 and space_before is False and tok["kind"] != "punct":
                space_before = True
            built.append(
                {
                    "text": tok["text"],
                    "kind": tok["kind"],
                    "space_before": space_before,
                }
            )
    return built


def _get_leading_space(tokens: list[dict], index: int) -> bool:
    if index <= 0:
        return False
    if index >= len(tokens):
        return True
    return tokens[index].get("space_before") is not False


def _build_text_from_tokens_with_breaks(tokens: list[dict], breaks: list[int]) -> str:
    break_counts: dict[int, int] = {}
    for idx in breaks:
        break_counts[idx] = break_counts.get(idx, 0) + 1
    visible_idx = 0
    at_line_start = True
    result_parts: list[str] = []
    for tok in tokens:
        text = tok.get("text") or ""
        if not text:
            continue
        needs_space = not at_line_start and tok.get("space_before") is not False
        if needs_space:
            result_parts.append(" ")
        result_parts.append(text)
        visible_idx += 1
        count = break_counts.get(visible_idx, 0)
        if count:
            result_parts.append("\n" * count)
            at_line_start = True
        else:
            at_line_start = False
    return "".join(result_parts)


def _coerce_payload(payload: object | None) -> dict:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, BaseModel):
        return payload.model_dump()
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    if hasattr(payload, "dict"):
        return payload.dict()
    return dict(payload)


def _normalize_operation(ann: Annotation) -> str:
    payload = _coerce_payload(getattr(ann, "payload", None))
    op = payload.get("operation") or ("replace" if ann.replacement else "noop")
    before_tokens = payload.get("before_tokens") or []
    after_tokens = payload.get("after_tokens") or []
    has_replacement = bool(ann.replacement)
    if op == "noop" and (before_tokens or after_tokens or has_replacement):
        return "replace"
    return str(op)


def _apply_annotations(tokens: list[dict], annotations: list[Annotation]) -> list[dict]:
    working = [dict(tok) for tok in tokens]
    offset_deltas: list[tuple[int, int]] = []

    def offset_at(index: int) -> int:
        return sum(delta for start, delta in offset_deltas if start <= index)

    def clamp_index(idx: int) -> int:
        return max(0, min(len(working), idx))

    sorted_anns = sorted(
        annotations,
        key=lambda ann: (
            0 if _normalize_operation(ann) == "move" else 1,
            ann.start_token or 0,
            ann.end_token or 0,
            ann.id or 0,
        ),
    )
    for ann in sorted_anns:
        payload = _coerce_payload(getattr(ann, "payload", None))
        operation = _normalize_operation(ann)
        if operation == "noop":
            continue
        if operation == "move":
            move_from = payload.get("move_from")
            if not isinstance(move_from, int):
                move_from = payload.get("moveFrom")
            if not isinstance(move_from, int):
                move_from = ann.start_token or 0
            move_to = payload.get("move_to")
            if not isinstance(move_to, int):
                move_to = payload.get("moveTo")
            if not isinstance(move_to, int):
                move_to = ann.start_token or 0
            move_len = payload.get("move_len")
            after_tokens = payload.get("after_tokens") or []
            before_tokens = payload.get("before_tokens") or []
            if not isinstance(move_len, int):
                move_len = len(after_tokens) or len(before_tokens) or max(1, (ann.end_token or 0) - (ann.start_token or 0) + 1)
            source_start = clamp_index(move_from + offset_at(move_from))
            source_end = max(source_start, min(len(working) - 1, source_start + move_len - 1))
            moved = working[source_start:source_end + 1]
            del working[source_start:source_end + 1]
            insertion_index = clamp_index(move_to + offset_at(move_to))
            if insertion_index > source_start:
                insertion_index -= len(moved)
            insertion_index = clamp_index(insertion_index)
            leading_space = _get_leading_space(working, insertion_index)
            if moved:
                moved[0]["space_before"] = leading_space
            working[insertion_index:insertion_index] = moved
            continue

        start_original = ann.start_token or 0
        end_original = ann.end_token or start_original
        target_start = clamp_index(start_original + offset_at(start_original))
        leading_space = _get_leading_space(working, target_start)
        before_tokens = payload.get("before_tokens") or []
        remove_count = 0
        if operation != "insert":
            if isinstance(before_tokens, list) and before_tokens:
                remove_count = len(before_tokens)
            else:
                remove_count = max(0, end_original - start_original + 1)
        if target_start + remove_count > len(working):
            remove_count = max(0, len(working) - target_start)
        after_tokens = payload.get("after_tokens") or []
        replacement_text = ann.replacement or ""
        new_tokens = _build_tokens_from_fragments(after_tokens if isinstance(after_tokens, list) else [], replacement_text, leading_space)
        if operation == "delete":
            new_tokens = []
        working[target_start:target_start + remove_count] = new_tokens
        offset_deltas.append((start_original, len(new_tokens) - remove_count))
    return working


def _render_corrected_text(source: str, annotations: Iterable[object]) -> str:
    base_tokens = _resolve_tokens_snapshot_for_source(source, annotations)
    line_breaks = _compute_line_breaks(source)
    corrected_tokens = _apply_annotations(base_tokens, annotations)
    return _build_text_from_tokens_with_breaks(corrected_tokens, line_breaks)


def _annotation_to_edit(ann: Annotation) -> dict:
    payload = ann.payload or {}
    operation = _normalize_operation(ann)
    move_from = payload.get("move_from") or payload.get("moveFrom")
    move_to = payload.get("move_to") or payload.get("moveTo")
    move_len = payload.get("move_len") or payload.get("moveLen")
    return {
        "start_token": ann.start_token,
        "end_token": ann.end_token,
        "operation": operation,
        "error_type": _resolve_label(ann),
        "replacement": None if ann.replacement is None else str(ann.replacement),
        "move_from": move_from if isinstance(move_from, int) else None,
        "move_to": move_to if isinstance(move_to, int) else None,
        "move_len": move_len if isinstance(move_len, int) else None,
    }


def _build_export_record(
    text: TextSample,
    annotations: list[Annotation],
) -> dict:
    source = text.content or ""
    target = _render_corrected_text(source, annotations)
    edits = [_annotation_to_edit(ann) for ann in sorted(annotations, key=lambda ann: (ann.start_token, ann.end_token, ann.id or 0))]
    return {
        "id": text.id,
        "source": source,
        "target": target,
        "edits": edits,
    }


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
        variants.append(_build_export_record(text, annotations))

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
            variants.append(_build_export_record(text, annotations))
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
