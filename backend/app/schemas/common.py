from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenPayload(BaseModel):
    sub: UUID
    exp: int


class OrmBase(BaseModel):
    class Config:
        from_attributes = True


class UserBase(OrmBase):
    id: UUID
    username: str
    full_name: Optional[str]
    role: str


class UserCreate(BaseModel):
    username: str
    password: str = Field(min_length=8)
    full_name: Optional[str]
    role: str = "annotator"


class UserUpdate(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None


class CategoryBase(BaseModel):
    name: str
    description: Optional[str] = None


class CategoryCreate(CategoryBase):
    pass


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class CategoryRead(OrmBase, CategoryBase):
    id: int
    total_texts: int = 0
    remaining_texts: int = 0
    in_progress_texts: int = 0
    awaiting_review_texts: int = 0


class TextRead(OrmBase):
    id: int
    content: str
    category_id: int
    required_annotations: int


class TokenFragmentPayload(BaseModel):
    id: str
    text: str
    origin: Literal["base", "inserted"] = "base"
    source_id: Optional[str] = None

    class Config:
        extra = "allow"  # tolerate older/untyped payloads


class AnnotationDetailPayload(BaseModel):
    text_sha256: Optional[str] = None  # hash of the full source text to guard against drift
    operation: Literal["replace", "delete", "insert", "move", "noop"] = "replace"
    before_tokens: list[str] = Field(default_factory=list)
    after_tokens: list[TokenFragmentPayload] = Field(default_factory=list)
    text_tokens: list[str] = Field(default_factory=list)  # token snapshot used by the client
    text_tokens_sha256: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = None  # e.g., "import", "manual"

    class Config:
        extra = "allow"  # keep backward compatibility with arbitrary payloads


class AnnotationPayload(BaseModel):
    id: Optional[int] = None
    start_token: int
    end_token: int
    replacement: Optional[str]
    error_type_id: int
    payload: AnnotationDetailPayload = Field(default_factory=AnnotationDetailPayload)


class AnnotationRead(OrmBase, AnnotationPayload):
    id: int
    author_id: UUID
    version: int


class AnnotationSaveRequest(BaseModel):
    annotations: list[AnnotationPayload]
    client_version: int = 0


class TextAssignmentResponse(BaseModel):
    text: TextRead
    annotations: list[AnnotationRead]
    lock_expires_at: Optional[datetime] = None


class TextImportRequest(BaseModel):
    category_id: int
    texts: list[str]
    required_annotations: int = Field(default=2, ge=1)


class TextImportResponse(BaseModel):
    inserted: int


class FlagRequest(BaseModel):
    reason: Optional[str] = None


class FlaggedTextRead(OrmBase):
    id: int
    text: TextRead
    reason: Optional[str]
    created_at: datetime
    flag_type: str


class AnnotationHistoryItem(BaseModel):
    text_id: int
    status: str
    updated_at: datetime
    preview: str


class DiffPair(BaseModel):
    pair: list[str]
    only_left: list[tuple[int, int, Optional[str], int]]
    only_right: list[tuple[int, int, Optional[str], int]]


class TextDiffResponse(BaseModel):
    text_id: int
    pairs: list[DiffPair]


class CrossValidationRead(OrmBase):
    text_id: int
    status: str
    result: dict
    updated_at: datetime
