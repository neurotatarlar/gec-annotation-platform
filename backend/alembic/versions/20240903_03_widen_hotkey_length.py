"""Widen hotkey columns to Text (and allow longer alembic version ids)

Revision ID: 20240903_03_widen_hotkey_length
Revises: 20240903_02_seed_error_types
Create Date: 2024-09-03 00:00:01.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20240903_03_widen_hotkey_length"
down_revision = "20240903_02_seed_error_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Allow longer revision identifiers and hotkeys
    op.alter_column("alembic_version", "version_num", type_=sa.String(length=64))
    op.alter_column("error_types", "default_hotkey", type_=sa.Text())
    op.alter_column("user_error_types", "hotkey", type_=sa.Text())


def downgrade() -> None:
    op.alter_column("error_types", "default_hotkey", type_=sa.String(length=8))
    op.alter_column("user_error_types", "hotkey", type_=sa.String(length=8))
    op.alter_column("alembic_version", "version_num", type_=sa.String(length=32))
