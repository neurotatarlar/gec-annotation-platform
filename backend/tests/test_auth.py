import os

import pytest
from fastapi import HTTPException
from fastapi.security import OAuth2PasswordRequestForm

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
import app.routers.auth as auth_router
import app.services.auth as auth_service
from app.models import Base, User
from app.schemas.common import UserCreate, UserUpdate


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


def seed_user(
    session,
    *,
    username: str,
    password_hash: str,
    role: str = "annotator",
    is_active: bool = True,
    full_name: str | None = None,
) -> User:
    user = User(
        username=username,
        password_hash=password_hash,
        role=role,
        is_active=is_active,
        full_name=full_name,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def form(username: str, password: str) -> OAuth2PasswordRequestForm:
    return OAuth2PasswordRequestForm(
        username=username,
        password=password,
        scope="",
        grant_type="password",
        client_id=None,
        client_secret=None,
    )


def test_login_for_access_token_returns_token(session, monkeypatch: pytest.MonkeyPatch):
    seed_user(session, username="alice", password_hash="Password123!")
    monkeypatch.setattr(auth_router, "verify_password", lambda plain, hashed: plain == hashed)

    token = auth_router.login_for_access_token(form_data=form("alice", "Password123!"), db=session)
    assert token.token_type == "bearer"
    assert token.access_token


def test_login_for_access_token_rejects_invalid_credentials(session, monkeypatch: pytest.MonkeyPatch):
    seed_user(session, username="alice", password_hash="Password123!")
    monkeypatch.setattr(auth_router, "verify_password", lambda plain, hashed: plain == hashed)

    with pytest.raises(HTTPException) as wrong_password:
        auth_router.login_for_access_token(form_data=form("alice", "bad"), db=session)
    assert wrong_password.value.status_code == 401
    assert wrong_password.value.detail == "Incorrect credentials"

    with pytest.raises(HTTPException) as unknown_user:
        auth_router.login_for_access_token(form_data=form("unknown", "Password123!"), db=session)
    assert unknown_user.value.status_code == 401
    assert unknown_user.value.detail == "Incorrect credentials"


def test_create_user_hashes_password_and_rejects_duplicate(session, monkeypatch: pytest.MonkeyPatch):
    admin = seed_user(session, username="admin", password_hash="x", role="admin")
    monkeypatch.setattr(auth_router, "get_password_hash", lambda value: f"hash::{value}")

    created = auth_router.create_user(
        UserCreate(username="new-user", password="Password123!", full_name="New User"),
        db=session,
        _=admin,
    )
    assert created.username == "new-user"
    assert created.full_name == "New User"

    stored = session.query(User).filter(User.username == "new-user").one()
    assert stored.password_hash == "hash::Password123!"

    with pytest.raises(HTTPException) as duplicate:
        auth_router.create_user(
            UserCreate(username="new-user", password="Password123!", full_name=None),
            db=session,
            _=admin,
        )
    assert duplicate.value.status_code == 400
    assert duplicate.value.detail == "Username already registered"


def test_update_current_user_updates_username_and_password(session, monkeypatch: pytest.MonkeyPatch):
    user = seed_user(session, username="alice", password_hash="old")
    seed_user(session, username="bob", password_hash="other")
    monkeypatch.setattr(auth_router, "get_password_hash", lambda value: f"hash::{value}")

    with pytest.raises(HTTPException) as conflict:
        auth_router.update_current_user(
            UserUpdate(username="bob"),
            db=session,
            current_user=user,
        )
    assert conflict.value.status_code == 400
    assert conflict.value.detail == "Username already registered"

    updated = auth_router.update_current_user(
        UserUpdate(username="alice2", password="NewPassword123!"),
        db=session,
        current_user=user,
    )
    assert updated.username == "alice2"
    assert updated.password_hash == "hash::NewPassword123!"


def test_get_current_user_validates_token_and_active_flag(session):
    user = seed_user(session, username="alice", password_hash="x", is_active=True)
    token = auth_service.create_access_token(user.id)

    resolved = auth_service.get_current_user(token=token, db=session)
    assert resolved.id == user.id

    user.is_active = False
    session.commit()
    with pytest.raises(HTTPException) as inactive:
        auth_service.get_current_user(token=token, db=session)
    assert inactive.value.status_code == 401


def test_require_admin_allows_manager_and_rejects_annotator(session):
    manager = seed_user(session, username="manager", password_hash="x", role="manager")
    annotator = seed_user(session, username="annotator", password_hash="x", role="annotator")

    assert auth_service.require_admin(manager).id == manager.id
    with pytest.raises(HTTPException) as forbidden:
        auth_service.require_admin(annotator)
    assert forbidden.value.status_code == 403
    assert forbidden.value.detail == "Admin privileges required"
