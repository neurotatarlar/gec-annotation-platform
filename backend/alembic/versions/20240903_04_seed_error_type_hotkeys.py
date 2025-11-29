"""Seed default hotkeys for error types

Revision ID: 20240903_04_seed_error_type_hotkeys
Revises: 20240903_03_widen_hotkey_length
Create Date: 2024-09-03 00:00:02.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20240903_04_seed_error_type_hotkeys"
down_revision = "20240903_03_widen_hotkey_length"
branch_labels = None
depends_on = None


def upgrade() -> None:
    HOTKEYS = {
        # Fluency (Shift+number)
        "Calque": "shift+1",
        "CodeSwitch": "shift+2",
        "Collocation": "shift+3",
        "Paronym": "shift+4",
        "Pleonasm": "shift+5",
        "Style": "shift+6",
        "WordChoice": "shift+7",
        # Grammar (Shift+QWERTY row)
        "Agreement": "shift+q",
        "Case": "shift+w",
        "Hyphen": "shift+e",
        "Merge": "shift+r",
        "Particle": "shift+t",
        "Possessive": "shift+y",
        "Split": "shift+u",
        "VerbTense": "shift+i",
        "VerbVoice": "shift+o",
        "WordOrder": "shift+p",
        # Word errors (Shift+ASD...)
        "Dialect": "shift+a",
        "Script": "shift+s",
        "Spelling": "shift+d",
        # Punctuation (Shift+Z)
        "Punctuation": "shift+z",
    }

    error_types = sa.table(
        "error_types",
        sa.column("id", sa.Integer()),
        sa.column("en_name", sa.String()),
        sa.column("default_hotkey", sa.String()),
    )

    conn = op.get_bind()
    for en_name, hotkey in HOTKEYS.items():
        conn.execute(
            error_types.update()
            .where(error_types.c.en_name == en_name)
            .values(default_hotkey=hotkey)
        )


def downgrade() -> None:
    error_types = sa.table(
        "error_types",
        sa.column("en_name", sa.String()),
        sa.column("default_hotkey", sa.String()),
    )
    conn = op.get_bind()
    for en_name in [
        "Calque",
        "CodeSwitch",
        "Collocation",
        "Paronym",
        "Pleonasm",
        "Style",
        "WordChoice",
        "Agreement",
        "Case",
        "Hyphen",
        "Merge",
        "Particle",
        "Possessive",
        "Split",
        "VerbTense",
        "VerbVoice",
        "WordOrder",
        "Dialect",
        "Script",
        "Spelling",
        "Punctuation",
    ]:
        conn.execute(
            error_types.update()
            .where(error_types.c.en_name == en_name)
            .values(default_hotkey=None)
        )
