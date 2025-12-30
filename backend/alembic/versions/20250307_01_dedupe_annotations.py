"""Deduplicate identical annotations across authors.

Revision ID: 20250307_01_dedupe_annotations
Revises: 20250221_02_drop_unused_audit_logs
Create Date: 2025-03-07 00:00:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250307_01_dedupe_annotations"
down_revision = "20250221_02_drop_unused_audit_logs"
branch_labels = None
depends_on = None


def _payload_key(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode("utf-8")
        except Exception:
            return repr(value)
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(value)


def _delete_ids(bind, ids: list[int]) -> None:
    if not ids:
        return
    stmt = sa.text("DELETE FROM annotations WHERE id IN :ids").bindparams(
        sa.bindparam("ids", expanding=True)
    )
    chunk_size = 500
    for idx in range(0, len(ids), chunk_size):
        bind.execute(stmt, {"ids": ids[idx : idx + chunk_size]})


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, text_id, start_token, end_token, replacement, error_type_id, payload "
            "FROM annotations ORDER BY id"
        )
    ).fetchall()
    seen: set[tuple] = set()
    duplicates: list[int] = []
    for row in rows:
        payload_key = _payload_key(row.payload)
        key = (
            row.text_id,
            row.start_token,
            row.end_token,
            row.replacement,
            row.error_type_id,
            payload_key,
        )
        if key in seen:
            duplicates.append(row.id)
        else:
            seen.add(key)
    _delete_ids(bind, duplicates)


def downgrade() -> None:
    # Data cleanup is not reversible.
    pass
