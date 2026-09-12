"""Add immutable repair proposal revisions.

Revision ID: 20260812_01_repair_proposal_revisions
Revises: 20260811_01_annotation_repair_reviews
Create Date: 2026-08-12 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260812_01_repair_proposal_revisions"
down_revision = "20260811_01_annotation_repair_reviews"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "annotation_repair_items",
        sa.Column("proposal_revision", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_table(
        "annotation_repair_proposal_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "item_id",
            sa.Integer(),
            sa.ForeignKey("annotation_repair_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("candidate_hash", sa.String(length=64), nullable=False),
        sa.Column("proposed_target", sa.Text(), nullable=False),
        sa.Column("proposed_annotations", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("risk", sa.String(length=128), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("item_id", "revision", name="uniq_repair_item_revision"),
    )
    op.create_index(
        "ix_annotation_repair_proposal_revisions_item_id",
        "annotation_repair_proposal_revisions",
        ["item_id"],
    )
    op.execute(
        """
        INSERT INTO annotation_repair_proposal_revisions
            (item_id, revision, candidate_hash, proposed_target, proposed_annotations,
             confidence, risk, explanation, reason)
        SELECT id, 1, candidate_hash, proposed_target, proposed_annotations,
               confidence, risk, explanation, 'generated'
        FROM annotation_repair_items
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_annotation_repair_proposal_revisions_item_id",
        table_name="annotation_repair_proposal_revisions",
    )
    op.drop_table("annotation_repair_proposal_revisions")
    op.drop_column("annotation_repair_items", "proposal_revision")
