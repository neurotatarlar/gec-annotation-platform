import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from jose import jwt

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
import app.services.auth as auth_service
from app.models import Base, User


@pytest.fixture(autouse=True)
def setup_db():
    db.configure_engine("sqlite:///:memory:")
    tables = [User.__table__]
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)
    yield
    Base.metadata.drop_all(bind=db.engine, tables=tables)


@pytest.fixture
def session():
    s = db.SessionLocal()
    try:
        yield s
    finally:
        s.close()


def seed_user(session, username: str = "alice", *, is_active: bool = True) -> User:
    user = User(
        username=username,
        password_hash=auth_service.get_password_hash("Password123!"),
        is_active=is_active,
        role="annotator",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def test_password_hash_round_trip():
    plain = "Password123!"
    hashed = auth_service.get_password_hash(plain)

    assert hashed != plain
    assert auth_service.verify_password(plain, hashed)
    assert not auth_service.verify_password("wrong-password", hashed)


def test_create_access_token_includes_subject_claim():
    user_id = uuid.uuid4()

    token = auth_service.create_access_token(user_id, expires_delta=timedelta(minutes=5))
    payload = jwt.decode(
        token,
        auth_service.settings.security.secret_key,
        algorithms=[auth_service.settings.security.algorithm],
    )

    assert payload["sub"] == str(user_id)
    assert payload.get("exp") is not None


def test_get_current_user_rejects_missing_subject_claim(session):
    token = jwt.encode(
        {"exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        auth_service.settings.security.secret_key,
        algorithm=auth_service.settings.security.algorithm,
    )

    with pytest.raises(HTTPException) as exc:
        auth_service.get_current_user(token=token, db=session)
    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


def test_get_current_user_rejects_invalid_uuid_subject(session):
    token = jwt.encode(
        {"sub": "not-a-uuid", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        auth_service.settings.security.secret_key,
        algorithm=auth_service.settings.security.algorithm,
    )

    with pytest.raises(HTTPException) as exc:
        auth_service.get_current_user(token=token, db=session)
    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


def test_get_current_user_resolves_active_user(session):
    user = seed_user(session, username="active-user", is_active=True)
    token = auth_service.create_access_token(user.id)

    resolved = auth_service.get_current_user(token=token, db=session)

    assert resolved.id == user.id
