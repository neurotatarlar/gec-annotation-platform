"""Add sort order to error types.

Revision ID: 20250310_01_error_type_sort_order
Revises: 20250307_01_dedupe_annotations
Create Date: 2025-03-10 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250310_01_error_type_sort_order"
down_revision = "20250307_01_dedupe_annotations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "error_types",
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "WITH ordered AS ("
            " SELECT id,"
            " ROW_NUMBER() OVER (PARTITION BY category_en ORDER BY category_en, en_name, id) AS rn"
            " FROM error_types"
            ")"
            " UPDATE error_types"
            " SET sort_order = ordered.rn"
            " FROM ordered"
            " WHERE error_types.id = ordered.id"
        )
    )


def downgrade() -> None:
    op.drop_column("error_types", "sort_order")
