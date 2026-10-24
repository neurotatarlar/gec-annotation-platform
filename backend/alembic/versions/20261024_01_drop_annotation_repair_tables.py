"""Remove retired annotation repair tables and their data.

Revision ID: 20261024_01_drop_annotation_repair_tables
Revises: 20260812_03_approval_time_repair_evidence
Create Date: 2026-10-24
"""

from alembic import op

revision = "20261024_01_drop_annotation_repair_tables"
down_revision = "20260812_03_approval_time_repair_evidence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop dependent tables first. IF EXISTS also supports databases where unused
    # review tables were already removed manually; never cascade into other tables.
    for table in (
        "annotation_repair_proposal_revisions",
        "annotation_repair_items",
        "annotation_repair_batches",
        "annotation_repair_applications",
    ):
        op.drop_table(table, if_exists=True)


def downgrade() -> None:
    raise RuntimeError(
        "Annotation repair cleanup is irreversible; restore a database backup to downgrade."
    )
