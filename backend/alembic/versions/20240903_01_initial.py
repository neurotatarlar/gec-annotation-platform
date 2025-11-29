"""Initial schema reflecting current entities (no error_type.name, no scope)

Revision ID: 20240903_01_initial
Revises:
Create Date: 2024-09-03 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "20240903_01_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("full_name", sa.String(length=128), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("role", sa.String(length=32), server_default=sa.text("'annotator'"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
    )
    op.create_index("ix_users_id", "users", ["id"], unique=False)

    op.create_table(
        "categories",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )

    op.create_table(
        "error_types",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("default_color", sa.String(length=16), server_default=sa.text("'#ff7f50'"), nullable=False),
        sa.Column("default_hotkey", sa.Text(), nullable=True),
        sa.Column("category_en", sa.String(length=64), nullable=True),
        sa.Column("category_tt", sa.String(length=64), nullable=True),
        sa.Column("en_name", sa.String(length=128), nullable=True),
        sa.Column("tt_name", sa.String(length=128), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "texts",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(length=64), nullable=True),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("required_annotations", sa.Integer(), server_default=sa.text("2"), nullable=False),
        sa.Column("state", sa.String(length=32), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("locked_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["category_id"], ["categories.id"]),
        sa.ForeignKeyConstraint(["locked_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_texts_external_id", "texts", ["external_id"], unique=False)

    op.create_table(
        "annotation_tasks",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("text_id", sa.Integer(), nullable=False),
        sa.Column("annotator_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=32), server_default=sa.text("'in_progress'"), nullable=False),
        sa.ForeignKeyConstraint(["annotator_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["text_id"], ["texts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("text_id", "annotator_id", name="uniq_task"),
    )

    op.create_table(
        "user_error_types",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("error_type_id", sa.Integer(), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=True),
        sa.Column("hotkey", sa.Text(), nullable=True),
        sa.Column("custom_name", sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(["error_type_id"], ["error_types.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "error_type_id", name="uniq_user_error_type"),
    )

    op.create_table(
        "skipped_texts",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("text_id", sa.Integer(), nullable=False),
        sa.Column("annotator_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("flag_type", sa.String(length=16), server_default=sa.text("'skip'"), nullable=False),
        sa.ForeignKeyConstraint(["annotator_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["text_id"], ["texts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("text_id", "annotator_id", "flag_type", name="uniq_skipped_text"),
    )

    op.create_table(
        "annotations",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("text_id", sa.Integer(), nullable=False),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("start_token", sa.Integer(), nullable=False),
        sa.Column("end_token", sa.Integer(), nullable=False),
        sa.Column("replacement", sa.Text(), nullable=True),
        sa.Column("error_type_id", sa.Integer(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["error_type_id"], ["error_types.id"]),
        sa.ForeignKeyConstraint(["text_id"], ["texts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "annotation_versions",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("annotation_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(["annotation_id"], ["annotations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "audit_logs",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("entity", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "cross_validation_results",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("text_id", sa.Integer(), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("status", sa.String(length=32), server_default=sa.text("'pending'"), nullable=False),
        sa.ForeignKeyConstraint(["text_id"], ["texts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("cross_validation_results")
    op.drop_table("audit_logs")
    op.drop_table("annotation_versions")
    op.drop_table("annotations")
    op.drop_table("skipped_texts")
    op.drop_table("user_error_types")
    op.drop_table("annotation_tasks")
    op.drop_index("ix_texts_external_id", table_name="texts")
    op.drop_table("texts")
    op.drop_table("error_types")
    op.drop_table("categories")
    op.drop_index("ix_users_id", table_name="users")
    op.drop_table("users")
