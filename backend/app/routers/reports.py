"""
Admin reporting endpoints for payout/review accounting.
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, true
from sqlalchemy.orm import Session

from ..models import AnnotationTask, Category, TextSample, User
from ..schemas.reports import ReviewTotalsReport, ReviewTotalsRow, ReviewTotalsSummary
from ..services.auth import get_db, require_admin

router = APIRouter(prefix="/api/reports", tags=["reports"])


def _normalize_datetime(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _parse_role_list(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


@router.get("/review-totals", response_model=ReviewTotalsReport)
def get_review_totals(
    project_name: Optional[str] = Query(None, description="Category/project name"),
    category_id: Optional[int] = Query(None, ge=1, description="Category id"),
    roles: str = Query("annotator", description="Comma-separated user roles"),
    since: Optional[datetime] = Query(None, description="Count submitted tasks updated at/after this"),
    until: Optional[datetime] = Query(None, description="Count tasks up to this timestamp"),
    include_inactive: bool = Query(False, description="Include inactive users"),
    only_with_activity: bool = Query(True, description="Return only users with at least one task"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if (project_name is None) == (category_id is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of project_name or category_id")

    until_value = _normalize_datetime(until) or datetime.now(timezone.utc)
    since_value = _normalize_datetime(since)
    if since_value and since_value > until_value:
        raise HTTPException(status_code=400, detail="since must be less than or equal to until")

    role_values = _parse_role_list(roles)
    if not role_values:
        raise HTTPException(status_code=400, detail="roles must contain at least one role")

    category_query = db.query(Category)
    if category_id is not None:
        category = category_query.filter(Category.id == category_id).one_or_none()
    else:
        category = category_query.filter(Category.name == project_name).one_or_none()

    if category is None:
        raise HTTPException(status_code=404, detail="Project/category not found")

    since_condition = true() if since_value is None else AnnotationTask.updated_at >= since_value

    task_stats = (
        db.query(
            AnnotationTask.annotator_id.label("annotator_id"),
            func.count(AnnotationTask.id).label("all_tasks"),
            func.count(AnnotationTask.id)
            .filter(AnnotationTask.status == "submitted")
            .label("submitted_total"),
            func.count(AnnotationTask.id)
            .filter(AnnotationTask.status == "in_progress")
            .label("in_progress_total"),
            func.count(AnnotationTask.id)
            .filter(
                and_(
                    AnnotationTask.status == "submitted",
                    since_condition,
                )
            )
            .label("submitted_since"),
        )
        .join(TextSample, AnnotationTask.text_id == TextSample.id)
        .filter(TextSample.category_id == category.id, AnnotationTask.updated_at <= until_value)
        .group_by(AnnotationTask.annotator_id)
        .subquery()
    )

    user_query = (
        db.query(
            User,
            func.coalesce(task_stats.c.submitted_total, 0).label("submitted_total"),
            func.coalesce(task_stats.c.submitted_since, 0).label("submitted_since"),
            func.coalesce(task_stats.c.in_progress_total, 0).label("in_progress_total"),
            func.coalesce(task_stats.c.all_tasks, 0).label("all_tasks"),
        )
        .outerjoin(task_stats, task_stats.c.annotator_id == User.id)
        .filter(User.role.in_(role_values))
        .order_by(User.username.asc())
    )
    if not include_inactive:
        user_query = user_query.filter(User.is_active.is_(True))

    rows: list[ReviewTotalsRow] = []
    for user, submitted_total, submitted_since, in_progress_total, all_tasks in user_query.all():
        row = ReviewTotalsRow(
            user_id=user.id,
            username=user.username,
            full_name=user.full_name,
            role=user.role,
            is_active=user.is_active,
            submitted_total=int(submitted_total or 0),
            submitted_since=int(submitted_since or 0),
            in_progress_total=int(in_progress_total or 0),
            all_tasks=int(all_tasks or 0),
        )
        if not only_with_activity or row.all_tasks > 0:
            rows.append(row)

    totals = ReviewTotalsSummary(
        submitted_total=sum(item.submitted_total for item in rows),
        submitted_since=sum(item.submitted_since for item in rows),
        in_progress_total=sum(item.in_progress_total for item in rows),
        all_tasks=sum(item.all_tasks for item in rows),
        user_count=len(rows),
    )
    return ReviewTotalsReport(
        generated_at=datetime.now(timezone.utc),
        category_id=category.id,
        project_name=category.name,
        roles=role_values,
        since=since_value,
        until=until_value,
        rows=rows,
        totals=totals,
    )
