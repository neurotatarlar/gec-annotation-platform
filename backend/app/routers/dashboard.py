from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from ..models import AnnotationTask, Category, SkippedText, TextSample, User
from ..schemas.dashboard import (
    ActivityItem,
    AnnotatorSummary,
    CategorySummary,
    DashboardStats,
    FlaggedEntry,
    PaginatedActivity,
    PaginatedFlagged,
    PaginatedTasks,
    TaskEntry,
)
from ..services.auth import get_current_user, get_db

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _parse_int_list(value: Optional[str]) -> list[int]:
    if not value:
        return []
    items: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            items.append(int(part))
        except ValueError:
            continue
    return items


def _parse_uuid_list(value: Optional[str]) -> list[UUID]:
    if not value:
        return []
    items: list[UUID] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            items.append(UUID(part))
        except ValueError:
            continue
    return items


def _normalize_statuses(raw: Optional[str]) -> list[str]:
    if raw is None:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


@router.get("/stats", response_model=DashboardStats)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    total_texts = db.query(func.count(TextSample.id)).scalar() or 0
    pending = (
        db.query(func.count(TextSample.id))
        .filter(TextSample.state == "pending")
        .scalar()
        or 0
    )
    in_annotation = (
        db.query(func.count(TextSample.id))
        .filter(TextSample.state == "in_annotation")
        .scalar()
        or 0
    )
    awaiting = (
        db.query(func.count(TextSample.id))
        .filter(TextSample.state == "awaiting_cross_validation")
        .scalar()
        or 0
    )
    submitted_tasks = (
        db.query(func.count(AnnotationTask.id))
        .filter(AnnotationTask.status == "submitted")
        .scalar()
        or 0
    )
    skipped_count = (
        db.query(func.count(SkippedText.id))
        .filter(SkippedText.flag_type == "skip")
        .scalar()
        or 0
    )
    trashed_count = (
        db.query(func.count(SkippedText.id))
        .filter(SkippedText.flag_type == "trash")
        .scalar()
        or 0
    )

    completed_subquery = (
        db.query(TextSample.id)
        .outerjoin(
            AnnotationTask,
            and_(
                AnnotationTask.text_id == TextSample.id,
                AnnotationTask.status == "submitted",
            ),
        )
        .group_by(TextSample.id, TextSample.required_annotations)
        .having(func.count(AnnotationTask.id) >= TextSample.required_annotations)
        .subquery()
    )
    completed_texts = db.query(func.count()).select_from(completed_subquery).scalar() or 0

    return DashboardStats(
        total_texts=total_texts,
        pending_texts=pending,
        in_annotation_texts=in_annotation,
        awaiting_review_texts=awaiting,
        completed_texts=completed_texts,
        submitted_tasks=submitted_tasks,
        skipped_count=skipped_count,
        trashed_count=trashed_count,
        last_updated=datetime.utcnow(),
    )


@router.get("/annotators", response_model=list[AnnotatorSummary])
def list_annotators(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    rows = (
        db.query(User)
        .order_by(User.full_name.is_(None), User.full_name, User.username)
        .all()
    )
    return [
        AnnotatorSummary(id=row.id, username=row.username, full_name=row.full_name)
        for row in rows
    ]


@router.get("/flagged", response_model=PaginatedFlagged)
def list_flagged(
    flag_type: str = Query("skip", pattern="^(skip|trash)$"),
    category_ids: Optional[str] = Query(None, description="Comma-separated category ids"),
    annotator_ids: Optional[str] = Query(None, description="Comma-separated annotator uuids"),
    start: Optional[datetime] = Query(None, description="Start datetime (inclusive)"),
    end: Optional[datetime] = Query(None, description="End datetime (inclusive)"),
    sort: str = Query("created_at", pattern="^(created_at|updated_at|category|annotator|text)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category_list = _parse_int_list(category_ids)
    annotator_list = _parse_uuid_list(annotator_ids)

    query = (
        db.query(SkippedText, TextSample, Category, User)
        .join(TextSample, SkippedText.text_id == TextSample.id)
        .join(Category, TextSample.category_id == Category.id)
        .join(User, SkippedText.annotator_id == User.id)
        .filter(SkippedText.flag_type == flag_type)
    )
    if category_list:
        query = query.filter(TextSample.category_id.in_(category_list))
    if annotator_list:
        query = query.filter(SkippedText.annotator_id.in_(annotator_list))
    if start:
        query = query.filter(SkippedText.created_at >= start)
    if end:
        query = query.filter(SkippedText.created_at <= end)

    if sort == "category":
        order_column = Category.name
    elif sort == "annotator":
        order_column = User.username
    elif sort == "text":
        order_column = TextSample.id
    else:
        order_column = SkippedText.created_at

    order_expr = order_column.desc() if order == "desc" else order_column.asc()
    rows = (
        query.order_by(order_expr, SkippedText.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = [
        FlaggedEntry(
          id=flag.id,
          flag_type=flag.flag_type,
          reason=flag.reason,
          created_at=flag.created_at,
          text_id=text.id,
          text_preview=(text.content or "")[:200],
          category=CategorySummary(id=category.id, name=category.name),
          annotator=AnnotatorSummary(id=user.id, username=user.username, full_name=user.full_name),
        )
        for flag, text, category, user in rows
    ]
    next_offset = offset + len(items) if len(items) == limit else None
    return PaginatedFlagged(items=items, next_offset=next_offset)


@router.get("/submitted", response_model=PaginatedTasks)
def list_submitted_tasks(
    category_ids: Optional[str] = Query(None, description="Comma-separated category ids"),
    annotator_ids: Optional[str] = Query(None, description="Comma-separated annotator uuids"),
    start: Optional[datetime] = Query(None, description="Start datetime (inclusive)"),
    end: Optional[datetime] = Query(None, description="End datetime (inclusive)"),
    sort: str = Query("updated_at", pattern="^(updated_at|category|annotator|text)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category_list = _parse_int_list(category_ids)
    annotator_list = _parse_uuid_list(annotator_ids)
    query = (
        db.query(AnnotationTask, TextSample, Category, User)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .join(Category, TextSample.category_id == Category.id)
        .join(User, AnnotationTask.annotator_id == User.id)
        .filter(AnnotationTask.status == "submitted")
    )
    if category_list:
        query = query.filter(TextSample.category_id.in_(category_list))
    if annotator_list:
        query = query.filter(AnnotationTask.annotator_id.in_(annotator_list))
    if start:
        query = query.filter(AnnotationTask.updated_at >= start)
    if end:
        query = query.filter(AnnotationTask.updated_at <= end)

    if sort == "category":
        order_column = Category.name
    elif sort == "annotator":
        order_column = User.username
    elif sort == "text":
        order_column = TextSample.id
    else:
        order_column = AnnotationTask.updated_at

    order_expr = order_column.desc() if order == "desc" else order_column.asc()
    rows = (
        query.order_by(order_expr, AnnotationTask.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = [
        TaskEntry(
            task_id=task.id,
            text_id=text.id,
            status=task.status,
            updated_at=task.updated_at,
            text_preview=(text.content or "")[:200],
            category=CategorySummary(id=category.id, name=category.name),
            annotator=AnnotatorSummary(id=user.id, username=user.username, full_name=user.full_name),
        )
        for task, text, category, user in rows
    ]
    next_offset = offset + len(items) if len(items) == limit else None
    return PaginatedTasks(items=items, next_offset=next_offset)


@router.get("/history", response_model=PaginatedTasks)
def list_history(
    category_ids: Optional[str] = Query(None, description="Comma-separated category ids"),
    annotator_ids: Optional[str] = Query(None, description="Comma-separated annotator uuids"),
    start: Optional[datetime] = Query(None, description="Start datetime (inclusive)"),
    end: Optional[datetime] = Query(None, description="End datetime (inclusive)"),
    sort: str = Query("updated_at", pattern="^(updated_at|category|annotator|text)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category_list = _parse_int_list(category_ids)
    annotator_list = _parse_uuid_list(annotator_ids)
    query = (
        db.query(AnnotationTask, TextSample, Category, User)
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .join(Category, TextSample.category_id == Category.id)
        .join(User, AnnotationTask.annotator_id == User.id)
    )
    if category_list:
        query = query.filter(TextSample.category_id.in_(category_list))
    if annotator_list:
        query = query.filter(AnnotationTask.annotator_id.in_(annotator_list))
    if start:
        query = query.filter(AnnotationTask.updated_at >= start)
    if end:
        query = query.filter(AnnotationTask.updated_at <= end)

    if sort == "category":
        order_column = Category.name
    elif sort == "annotator":
        order_column = User.username
    elif sort == "text":
        order_column = TextSample.id
    else:
        order_column = AnnotationTask.updated_at

    order_expr = order_column.desc() if order == "desc" else order_column.asc()
    rows = (
        query.order_by(order_expr, AnnotationTask.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = [
        TaskEntry(
            task_id=task.id,
            text_id=text.id,
            status=task.status,
            updated_at=task.updated_at,
            text_preview=(text.content or "")[:200],
            category=CategorySummary(id=category.id, name=category.name),
            annotator=AnnotatorSummary(id=user.id, username=user.username, full_name=user.full_name),
        )
        for task, text, category, user in rows
    ]
    next_offset = offset + len(items) if len(items) == limit else None
    return PaginatedTasks(items=items, next_offset=next_offset)


@router.get("/activity", response_model=PaginatedActivity)
def list_activity(
    kinds: Optional[str] = Query(
        "skip,trash,task",
        description="Comma-separated list of kinds to include: skip, trash, task",
    ),
    task_statuses: Optional[str] = Query(None, description="Comma-separated task statuses to include"),
    category_ids: Optional[str] = Query(None, description="Comma-separated category ids"),
    annotator_ids: Optional[str] = Query(None, description="Comma-separated annotator uuids"),
    start: Optional[datetime] = Query(None, description="Start datetime (inclusive)"),
    end: Optional[datetime] = Query(None, description="End datetime (inclusive)"),
    sort: str = Query("occurred_at", pattern="^(occurred_at|category|annotator|text)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category_list = _parse_int_list(category_ids)
    annotator_list = _parse_uuid_list(annotator_ids)
    kind_list = [kind.strip() for kind in (kinds or "").split(",") if kind.strip()]
    if not kind_list:
        kind_list = ["skip", "trash", "task"]

    statuses = _normalize_statuses(task_statuses)
    max_fetch = min(limit + offset + 200, 2000)

    items: list[ActivityItem] = []

    if any(kind in kind_list for kind in ("skip", "trash")):
        flag_query = (
            db.query(SkippedText, TextSample, Category, User)
            .join(TextSample, SkippedText.text_id == TextSample.id)
            .join(Category, TextSample.category_id == Category.id)
            .join(User, SkippedText.annotator_id == User.id)
            .filter(SkippedText.flag_type.in_([k for k in kind_list if k in ("skip", "trash")]))
        )
        if category_list:
            flag_query = flag_query.filter(TextSample.category_id.in_(category_list))
        if annotator_list:
            flag_query = flag_query.filter(SkippedText.annotator_id.in_(annotator_list))
        if start:
            flag_query = flag_query.filter(SkippedText.created_at >= start)
        if end:
            flag_query = flag_query.filter(SkippedText.created_at <= end)
        flag_rows = (
            flag_query.order_by(SkippedText.created_at.desc(), SkippedText.id.desc())
            .limit(max_fetch)
            .all()
        )
        items.extend(
            ActivityItem(
                id=flag.id,
                text_id=text.id,
                kind=flag.flag_type,  # type: ignore[arg-type]
                status=flag.flag_type,
                occurred_at=flag.created_at,
                text_preview=(text.content or "")[:200],
                category=CategorySummary(id=category.id, name=category.name),
                annotator=AnnotatorSummary(id=user.id, username=user.username, full_name=user.full_name),
            )
            for flag, text, category, user in flag_rows
        )

    if "task" in kind_list:
        task_query = (
            db.query(AnnotationTask, TextSample, Category, User)
            .join(TextSample, AnnotationTask.text_id == TextSample.id)
            .join(Category, TextSample.category_id == Category.id)
            .join(User, AnnotationTask.annotator_id == User.id)
        )
        if statuses:
            task_query = task_query.filter(AnnotationTask.status.in_(statuses))
        if category_list:
            task_query = task_query.filter(TextSample.category_id.in_(category_list))
        if annotator_list:
            task_query = task_query.filter(AnnotationTask.annotator_id.in_(annotator_list))
        if start:
            task_query = task_query.filter(AnnotationTask.updated_at >= start)
        if end:
            task_query = task_query.filter(AnnotationTask.updated_at <= end)

        task_rows = (
            task_query.order_by(AnnotationTask.updated_at.desc(), AnnotationTask.id.desc())
            .limit(max_fetch)
            .all()
        )
        items.extend(
            ActivityItem(
                id=task.id,
                text_id=text.id,
                kind="task",
                status=task.status,
                occurred_at=task.updated_at,
                text_preview=(text.content or "")[:200],
                category=CategorySummary(id=category.id, name=category.name),
                annotator=AnnotatorSummary(id=user.id, username=user.username, full_name=user.full_name),
            )
            for task, text, category, user in task_rows
        )

    def _sort_key(item: ActivityItem):
        if sort == "category":
            return (item.category.name.lower() if item.category.name else "", item.occurred_at)
        if sort == "annotator":
            return (item.annotator.username.lower(), item.occurred_at)
        if sort == "text":
            return (item.text_id, item.occurred_at)
        return (item.occurred_at,)

    reverse = order == "desc"
    items.sort(key=_sort_key, reverse=reverse)

    slice_start = min(offset, len(items))
    slice_end = min(slice_start + limit, len(items))
    page_items = items[slice_start:slice_end]
    next_offset = slice_end if slice_end < len(items) else None
    return PaginatedActivity(items=page_items, next_offset=next_offset)
