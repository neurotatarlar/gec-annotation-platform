from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..models import ErrorType, UserErrorType
from ..schemas.common import OrmBase
from ..services.auth import get_current_user, get_db

router = APIRouter(prefix="/api/error-types", tags=["error-types"])


class ErrorTypeBase(BaseModel):
    description: str | None = None
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


@router.get("/", response_model=list[ErrorTypeRead])
def list_error_types(
    include_inactive: bool = Query(False, description="Include inactive error types"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    query = db.query(ErrorType)
    if not include_inactive:
        query = query.filter(ErrorType.is_active.is_(True))
    return query.order_by(ErrorType.category_en, ErrorType.en_name, ErrorType.id).all()


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
    obj = ErrorType(
        description=payload.description,
        default_color=payload.default_color,
        default_hotkey=_sanitize_str(payload.default_hotkey),
        category_en=_sanitize_str(payload.category_en),
        category_tt=_sanitize_str(payload.category_tt),
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
    update_fields = {
        "description": payload.description,
        "default_color": payload.default_color,
        "default_hotkey": _sanitize_str(payload.default_hotkey),
        "category_en": _sanitize_str(payload.category_en),
        "category_tt": _sanitize_str(payload.category_tt),
        "en_name": _sanitize_str(payload.en_name),
        "tt_name": _sanitize_str(payload.tt_name),
        "is_active": payload.is_active,
    }
    for key, value in update_fields.items():
        if value is not None:
            setattr(obj, key, value)
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
