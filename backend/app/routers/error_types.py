"""
Error type CRUD endpoints with category-aware ordering and preference handling.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import ErrorType, UserErrorType
from ..schemas.common import OrmBase
from ..services.auth import get_current_user, get_db

router = APIRouter(prefix="/api/error-types", tags=["error-types"])


class ErrorTypeBase(BaseModel):
    description: str | None = None
    sort_order: int | None = None
    default_color: str = "#f97316"
    default_hotkey: str | None = None
    category_en: str | None = None
    category_tt: str | None = None
    en_name: str | None = None
    tt_name: str | None = None
    is_active: bool = True


class ErrorTypeCreate(ErrorTypeBase):
    pass


class ErrorTypeUpdate(BaseModel):
    description: str | None = None
    sort_order: int | None = None
    default_color: str | None = None
    default_hotkey: str | None = None
    category_en: str | None = None
    category_tt: str | None = None
    en_name: str | None = None
    tt_name: str | None = None
    is_active: bool | None = None


class ErrorTypeRead(OrmBase, ErrorTypeBase):
    id: int


class ErrorTypePreference(BaseModel):
    color: str | None = None
    hotkey: str | None = None
    custom_name: str | None = None


class UserPreferenceRead(ErrorTypePreference):
    error_type_id: int


def _sanitize_str(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


def _sanitize_description(value: str | None) -> str | None:
    """Normalize description fields while preserving None."""
    return _sanitize_str(value)


@router.get("/", response_model=list[ErrorTypeRead])
def list_error_types(
    include_inactive: bool = Query(False, description="Include inactive error types"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    query = db.query(ErrorType)
    if not include_inactive:
        query = query.filter(ErrorType.is_active.is_(True))
    return query.order_by(
        ErrorType.category_en, ErrorType.sort_order, ErrorType.en_name, ErrorType.id
    ).all()


# @router.get("/preferences", response_model=list[UserPreferenceRead])
# def get_preferences(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
#     prefs = (
#         db.query(UserErrorType)
#         .filter(UserErrorType.user_id == current_user.id)
#         .order_by(UserErrorType.id)
#         .all()
#     )
#     return [
#         UserPreferenceRead(
#             error_type_id=pref.error_type_id,
#             color=pref.color,
#             hotkey=pref.hotkey,
#             custom_name=pref.custom_name,
#         )
#         for pref in prefs
#     ]


@router.post("/", response_model=ErrorTypeRead, status_code=status.HTTP_201_CREATED)
def create_error_type(
    payload: ErrorTypeCreate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    category_en = _sanitize_str(payload.category_en)
    category_tt = _sanitize_str(payload.category_tt)
    sort_order = payload.sort_order
    if sort_order is None:
        max_query = db.query(func.max(ErrorType.sort_order))
        if category_en is None:
            max_query = max_query.filter(ErrorType.category_en.is_(None))
        else:
            max_query = max_query.filter(ErrorType.category_en == category_en)
        max_order = max_query.scalar() or 0
        sort_order = max_order + 1
    obj = ErrorType(
        description=_sanitize_description(payload.description),
        sort_order=sort_order,
        default_color=payload.default_color or "#f97316",
        default_hotkey=_sanitize_str(payload.default_hotkey),
        category_en=category_en,
        category_tt=category_tt,
        en_name=_sanitize_str(payload.en_name),
        tt_name=_sanitize_str(payload.tt_name),
        is_active=payload.is_active,
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{error_type_id}", response_model=ErrorTypeRead)
def update_error_type(
    error_type_id: int,
    payload: ErrorTypeUpdate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    obj = db.get(ErrorType, error_type_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Error type not found")
    old_category_en = obj.category_en
    category_en = _sanitize_str(payload.category_en) if payload.category_en is not None else obj.category_en
    category_changed = payload.category_en is not None and category_en != old_category_en
    if payload.category_en is not None:
        obj.category_en = category_en
    update_fields = {
        "description": _sanitize_description(payload.description),
        "sort_order": payload.sort_order,
        "default_color": payload.default_color,
        "default_hotkey": _sanitize_str(payload.default_hotkey),
        "category_tt": _sanitize_str(payload.category_tt),
        "en_name": _sanitize_str(payload.en_name),
        "tt_name": _sanitize_str(payload.tt_name),
        "is_active": payload.is_active,
    }
    for key, value in update_fields.items():
        if value is not None:
            setattr(obj, key, value)
    if category_changed and payload.sort_order is None:
        max_query = db.query(func.max(ErrorType.sort_order))
        if category_en is None:
            max_query = max_query.filter(ErrorType.category_en.is_(None))
        else:
            max_query = max_query.filter(ErrorType.category_en == category_en)
        max_order = max_query.scalar() or 0
        obj.sort_order = max_order + 1
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{error_type_id}/preferences", response_model=ErrorTypePreference)
def upsert_preferences(
    error_type_id: int,
    payload: ErrorTypePreference,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    error_type = db.get(ErrorType, error_type_id)
    if not error_type:
        raise HTTPException(status_code=404, detail="Error type not found")
    pref = (
        db.query(UserErrorType)
        .filter(
            UserErrorType.error_type_id == error_type_id,
            UserErrorType.user_id == current_user.id,
        )
        .one_or_none()
    )
    if not pref:
        pref = UserErrorType(
            error_type_id=error_type_id,
            user_id=current_user.id,
        )
        db.add(pref)
    pref.color = payload.color
    pref.hotkey = payload.hotkey
    pref.custom_name = payload.custom_name
    db.commit()
    db.refresh(pref)
    return ErrorTypePreference(color=pref.color, hotkey=pref.hotkey, custom_name=pref.custom_name)
