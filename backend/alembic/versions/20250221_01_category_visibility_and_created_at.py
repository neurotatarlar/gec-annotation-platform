"""Add category visibility and created_at

Revision ID: 20250221_01_category_visibility_and_created_at
Revises: 20240903_04_seed_error_type_hotkeys
Create Date: 2025-02-21 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision = "20250221_01_category_visibility_and_created_at"
down_revision = "20240903_04_seed_error_type_hotkeys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("categories")}

    if "created_at" not in columns:
        op.add_column(
            "categories",
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.execute("UPDATE categories SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)")

    if "is_hidden" not in columns:
        op.add_column(
            "categories",
            sa.Column("is_hidden", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("categories")}

    if "is_hidden" in columns:
        op.drop_column("categories", "is_hidden")
    if "created_at" in columns:
        op.drop_column("categories", "created_at")
