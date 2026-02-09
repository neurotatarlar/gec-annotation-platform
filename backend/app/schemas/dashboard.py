"""
Pydantic schemas for dashboard filters and summary responses.
"""

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class AnnotatorSummary(BaseModel):
    id: UUID
    username: str
    full_name: Optional[str] = None


class CategorySummary(BaseModel):
    id: int
    name: str


class FlaggedEntry(BaseModel):
    id: int
    flag_type: str
    reason: Optional[str]
    created_at: datetime
    text_id: int
    text_preview: str
    category: CategorySummary
    annotator: AnnotatorSummary


class TaskEntry(BaseModel):
    task_id: int
    text_id: int
    status: str
    updated_at: datetime
    text_preview: str
    category: CategorySummary
    annotator: AnnotatorSummary


class PaginatedFlagged(BaseModel):
    items: list[FlaggedEntry]
    next_offset: Optional[int] = None


class PaginatedTasks(BaseModel):
    items: list[TaskEntry]
    next_offset: Optional[int] = None


class DashboardStats(BaseModel):
    total_texts: int = 0
    pending_texts: int = 0
    in_annotation_texts: int = 0
    awaiting_review_texts: int = 0
    completed_texts: int = 0
    submitted_tasks: int = 0
    skipped_count: int = 0
    trashed_count: int = 0
    last_updated: datetime = Field(default_factory=datetime.utcnow)


class ActivityItem(BaseModel):
    id: int
    text_id: int
    kind: Literal["skip", "trash", "task"]
    status: Optional[str] = None
    occurred_at: datetime
    text_preview: str
    category: CategorySummary
    annotator: AnnotatorSummary


class PaginatedActivity(BaseModel):
    items: list[ActivityItem]
    next_offset: Optional[int] = None
