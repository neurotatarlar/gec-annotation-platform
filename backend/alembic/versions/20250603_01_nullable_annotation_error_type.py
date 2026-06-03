"""Allow draft annotations without an error type.

Revision ID: 20250603_01_nullable_annotation_error_type
Revises: 20250310_01_error_type_sort_order
Create Date: 2026-06-03 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250603_01_nullable_annotation_error_type"
down_revision = "20250310_01_error_type_sort_order"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "annotations",
        "error_type_id",
        existing_type=sa.Integer(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "annotations",
        "error_type_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
