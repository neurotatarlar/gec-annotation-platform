"""Add approval-time evidence to repair items.

Revision ID: 20260812_03_approval_time_repair_evidence
Revises: 20260812_02_sync_production_error_types
Create Date: 2026-08-12 13:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260812_03_approval_time_repair_evidence"
down_revision = "20260812_02_sync_production_error_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "annotation_repair_items",
        sa.Column("restored_target", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "annotation_repair_items",
        sa.Column(
            "recovery_evidence",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "annotation_repair_items",
        sa.Column("uncertainty_acknowledged", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.execute("UPDATE annotation_repair_items SET restored_target = current_target")


def downgrade() -> None:
    op.drop_column("annotation_repair_items", "uncertainty_acknowledged")
    op.drop_column("annotation_repair_items", "recovery_evidence")
    op.drop_column("annotation_repair_items", "restored_target")
