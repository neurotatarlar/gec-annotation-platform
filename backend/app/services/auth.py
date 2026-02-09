"""
Password hashing and JWT helpers for authentication flows.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import SessionLocal
from ..models import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")
settings = get_settings()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(subject: UUID, expires_delta: Optional[timedelta] = None) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.security.access_token_expire_minutes)
    )
    to_encode = {"sub": str(subject), "exp": expire}
    return jwt.encode(to_encode, settings.security.secret_key, algorithm=settings.security.algorithm)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token,
            settings.security.secret_key,
            algorithms=[settings.security.algorithm],
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        user_uuid = UUID(user_id)
    except (JWTError, ValueError, TypeError) as exc:  # pragma: no cover - FastAPI handles response
        raise credentials_exception from exc

    user = db.get(User, user_uuid)
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user
