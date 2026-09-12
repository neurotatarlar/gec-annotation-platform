"""Add isolated annotation repair review and application audit tables.

Revision ID: 20260811_01_annotation_repair_reviews
Revises: 20250603_01_nullable_annotation_error_type
Create Date: 2026-08-11 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260811_01_annotation_repair_reviews"
down_revision = "20250603_01_nullable_annotation_error_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "annotation_repair_batches",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("source_snapshot_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="reviewing"),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "annotation_repair_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "batch_id",
            sa.String(length=64),
            sa.ForeignKey("annotation_repair_batches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("text_id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=False),
        sa.Column("current_target", sa.Text(), nullable=False),
        sa.Column("proposed_target", sa.Text(), nullable=False),
        sa.Column("original_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("candidate_hash", sa.String(length=64), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False, server_default="low"),
        sa.Column("risk", sa.String(length=128), nullable=False, server_default="legacy"),
        sa.Column("explanation", sa.Text(), nullable=False, server_default=""),
        sa.Column("proposed_annotations", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("reviewed_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("batch_id", "text_id", "task_id", name="uniq_repair_batch_task"),
    )
    op.create_index("ix_annotation_repair_items_batch_id", "annotation_repair_items", ["batch_id"])
    op.create_index("ix_annotation_repair_items_text_id", "annotation_repair_items", ["text_id"])
    op.create_index("ix_annotation_repair_items_status", "annotation_repair_items", ["status"])
    op.create_table(
        "annotation_repair_applications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("batch_id", sa.String(length=64), nullable=False),
        sa.Column("manifest_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("before_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("after_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("before_m2_sha256", sa.String(length=64), nullable=True),
        sa.Column("after_m2_sha256", sa.String(length=64), nullable=True),
        sa.Column("applied_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("annotation_repair_applications")
    op.drop_index("ix_annotation_repair_items_status", table_name="annotation_repair_items")
    op.drop_index("ix_annotation_repair_items_text_id", table_name="annotation_repair_items")
    op.drop_index("ix_annotation_repair_items_batch_id", table_name="annotation_repair_items")
    op.drop_table("annotation_repair_items")
    op.drop_table("annotation_repair_batches")
