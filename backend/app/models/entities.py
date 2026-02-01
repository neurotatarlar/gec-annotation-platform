import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func, JSON
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql.type_api import TypeEngine

from .base import Base

# Use JSON for sqlite while keeping JSONB on Postgres.
JsonType: TypeEngine = JSON().with_variant(JSONB, "postgresql")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True
    )
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    role: Mapped[str] = mapped_column(String(32), default="annotator")

    annotations: Mapped[list["Annotation"]] = relationship(back_populates="author")


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    texts: Mapped[list["TextSample"]] = relationship(back_populates="category")


class TextSample(Base):
    __tablename__ = "texts"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    external_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    required_annotations: Mapped[int] = mapped_column(Integer, default=2)
    state: Mapped[str] = mapped_column(String(32), default="pending")
    locked_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"), nullable=True)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    category: Mapped["Category"] = relationship(back_populates="texts")
    annotations: Mapped[list["Annotation"]] = relationship(back_populates="text")


class AnnotationTask(Base):
    __tablename__ = "annotation_tasks"
    __table_args__ = (UniqueConstraint("text_id", "annotator_id", name="uniq_task"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    text_id: Mapped[int] = mapped_column(ForeignKey("texts.id"), nullable=False)
    annotator_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="in_progress")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=func.now(), server_default=func.now(), onupdate=func.now()
    )

    text: Mapped[TextSample] = relationship()
    annotator: Mapped[User] = relationship()


class ErrorType(Base):
    __tablename__ = "error_types"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    description: Mapped[Optional[str]]
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    default_color: Mapped[str] = mapped_column(String(16), default="#ff7f50")
    default_hotkey: Mapped[Optional[str]] = mapped_column(Text)
    category_en: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    category_tt: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    en_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tt_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class UserErrorType(Base):
    __tablename__ = "user_error_types"
    __table_args__ = (UniqueConstraint("user_id", "error_type_id", name="uniq_user_error_type"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    error_type_id: Mapped[int] = mapped_column(ForeignKey("error_types.id"), nullable=False)
    color: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    hotkey: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    custom_name: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    user: Mapped[User] = relationship()
    error_type: Mapped[ErrorType] = relationship()


class SkippedText(Base):
    __tablename__ = "skipped_texts"
    __table_args__ = (
        UniqueConstraint("text_id", "annotator_id", "flag_type", name="uniq_skipped_text"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    text_id: Mapped[int] = mapped_column(ForeignKey("texts.id"), nullable=False)
    annotator_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    flag_type: Mapped[str] = mapped_column(String(16), default="skip")

    text: Mapped[TextSample] = relationship()
    annotator: Mapped[User] = relationship()


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    text_id: Mapped[int] = mapped_column(ForeignKey("texts.id"), nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    start_token: Mapped[int] = mapped_column(Integer)
    end_token: Mapped[int] = mapped_column(Integer)
    replacement: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error_type_id: Mapped[int] = mapped_column(ForeignKey("error_types.id"))
    payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)

    text: Mapped[TextSample] = relationship(back_populates="annotations")
    author: Mapped[User] = relationship(back_populates="annotations")
    error_type: Mapped[ErrorType] = relationship()


class AnnotationVersion(Base):
    __tablename__ = "annotation_versions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    annotation_id: Mapped[int] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CrossValidationResult(Base):
    __tablename__ = "cross_validation_results"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    text_id: Mapped[int] = mapped_column(ForeignKey("texts.id"), nullable=False)
    result: Mapped[dict] = mapped_column(JsonType, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="pending")
