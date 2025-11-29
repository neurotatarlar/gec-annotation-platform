from datetime import datetime, timedelta, timezone
from itertools import combinations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationTask, Category, CrossValidationResult, SkippedText, TextSample
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


@router.post("/import", response_model=TextImportResponse, status_code=status.HTTP_201_CREATED)
def import_texts(
    request: TextImportRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    category = db.get(Category, request.category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    entries = [text.strip() for text in request.texts if isinstance(text, str) and text.strip()]
    if not entries:
        raise HTTPException(status_code=400, detail="No texts provided")
    for body in entries:
        db.add(
            TextSample(
                content=body,
                category_id=category.id,
                required_annotations=request.required_annotations,
            )
        )
    db.commit()
    return TextImportResponse(inserted=len(entries))


@router.post("/assignments/next", response_model=TextAssignmentResponse)
def get_next_text(
    category_id: int = Query(..., description="Category identifier"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    category = db.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    now = datetime.now(timezone.utc)
    # release expired locks
    db.query(TextSample).filter(
        TextSample.locked_at.isnot(None), TextSample.locked_at < now - LOCK_DURATION
    ).update(
        {TextSample.locked_by_id: None, TextSample.locked_at: None}, synchronize_session=False
    )

    skipped_subquery = (
        select(SkippedText.text_id)
        .where(SkippedText.annotator_id == current_user.id)
        .subquery()
    )
    submitted_subquery = (
        select(AnnotationTask.text_id)
        .where(AnnotationTask.annotator_id == current_user.id, AnnotationTask.status == "submitted")
        .subquery()
    )

    stmt = (
        select(TextSample)
        .where(
            TextSample.category_id == category_id,
            TextSample.state.in_(["pending", "in_annotation"]),
            ~TextSample.id.in_(skipped_subquery),
            ~TextSample.id.in_(submitted_subquery),
            or_(
                TextSample.locked_by_id.is_(None),
                TextSample.locked_by_id == current_user.id,
            ),
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
    text = db.get(TextSample, text_id)
    if not text:
        raise HTTPException(status_code=404, detail="Text not found")

    existing = (
        db.query(Annotation)
        .filter(Annotation.text_id == text_id, Annotation.author_id == current_user.id)
        .all()
    )
    existing_map = {
        (annotation.start_token, annotation.end_token): annotation for annotation in existing
    }

    seen_keys: set[tuple[int, int]] = set()
    saved: list[Annotation] = []
    for item in request.annotations:
        key = (item.start_token, item.end_token)
        seen_keys.add(key)
        annotation = existing_map.get(key)
        if annotation:
            annotation.replacement = item.replacement
            annotation.payload = item.payload
            annotation.error_type_id = item.error_type_id
            annotation.version += 1
        else:
            annotation = Annotation(
                text_id=text_id,
                author_id=current_user.id,
                start_token=item.start_token,
                end_token=item.end_token,
                replacement=item.replacement,
                payload=item.payload,
                error_type_id=item.error_type_id,
            )
            db.add(annotation)
        saved.append(annotation)

    for key, annotation in existing_map.items():
        if key not in seen_keys:
            db.delete(annotation)

    db.commit()
    return saved


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

    completed_count = (
        db.query(AnnotationTask)
        .filter(AnnotationTask.text_id == text_id, AnnotationTask.status == "submitted")
        .count()
    )
    if completed_count >= text.required_annotations:
        text.state = "awaiting_cross_validation"
        _queue_cross_validation(db=db, text_id=text_id)
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
