"""
Authentication endpoints for login and token issuance.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User
from ..schemas.common import Token, UserBase, UserCreate, UserUpdate
from ..services.auth import (
    create_access_token,
    get_current_user,
    get_db,
    get_password_hash,
    require_admin,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()


@router.post("/token", response_model=Token)
def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)
) -> Token:
    user = db.query(User).filter(User.username == form_data.username).one_or_none()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")
    access_token_expires = timedelta(minutes=settings.security.access_token_expire_minutes)
    token = create_access_token(user.id, expires_delta=access_token_expires)
    return Token(access_token=token)


@router.post("/users", response_model=UserBase)
def create_user(user_in: UserCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    if db.query(User).filter(User.username == user_in.username).first():
        raise HTTPException(status_code=400, detail="Username already registered")
    user = User(
        username=user_in.username,
        password_hash=get_password_hash(user_in.password),
        full_name=user_in.full_name,
        role=user_in.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("/me", response_model=UserBase)
def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.put("/me", response_model=UserBase)
def update_current_user(
    payload: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.username:
        existing = (
            db.query(User)
            .filter(User.username == payload.username, User.id != current_user.id)
            .one_or_none()
        )
        if existing:
            raise HTTPException(status_code=400, detail="Username already registered")
        current_user.username = payload.username

    if payload.password:
        current_user.password_hash = get_password_hash(payload.password)

    db.commit()
    db.refresh(current_user)
    return current_user
