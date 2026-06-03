"""
Schemas for payout/review reporting endpoints.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel


class ReviewTotalsRow(BaseModel):
    user_id: UUID
    username: str
    full_name: Optional[str] = None
    role: str
    is_active: bool
    submitted_total: int = 0
    submitted_since: int = 0
    in_progress_total: int = 0
    all_tasks: int = 0


class ReviewTotalsSummary(BaseModel):
    submitted_total: int = 0
    submitted_since: int = 0
    in_progress_total: int = 0
    all_tasks: int = 0
    user_count: int = 0


class ReviewTotalsReport(BaseModel):
    generated_at: datetime
    metric: str = "submitted_annotation_tasks"
    category_id: int
    project_name: str
    roles: list[str]
    since: Optional[datetime] = None
    until: datetime
    rows: list[ReviewTotalsRow]
    totals: ReviewTotalsSummary
