import os
import uuid

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Base, ErrorType, User, UserErrorType
from app.services.auth import get_current_user, get_db


def override_get_db():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


TEST_USER_ID = uuid.uuid4()


def override_get_current_user():
    return User(
        id=TEST_USER_ID,
        username="tester",
        password_hash="x",
        role="admin",
        is_active=True,
    )


@pytest.fixture(autouse=True)
def setup_db():
    # In-memory SQLite for fast tests; create only needed tables.
    db.configure_engine("sqlite:///:memory:")
    Base.metadata.drop_all(
        bind=db.engine,
        tables=[User.__table__, ErrorType.__table__, UserErrorType.__table__],
    )
    Base.metadata.create_all(
        bind=db.engine,
        tables=[User.__table__, ErrorType.__table__, UserErrorType.__table__],
    )
    # Seed a real user row so relationships are consistent if needed.
    with db.SessionLocal() as session:
        session.add(
            User(
                id=TEST_USER_ID,
                username="tester",
                password_hash="x",
                role="admin",
                is_active=True,
            )
        )
        session.commit()

    # Override dependencies
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    yield

    Base.metadata.drop_all(
        bind=db.engine,
        tables=[User.__table__, ErrorType.__table__, UserErrorType.__table__],
    )
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_list_error_types_filters_inactive_and_orders(client):
    with db.SessionLocal() as session:
        session.add_all(
            [
                ErrorType(
                    en_name="B",
                    category_en="Grammar",
                    default_color="#111",
                    default_hotkey="shift+b",
                    is_active=True,
                ),
                ErrorType(
                    en_name="A",
                    category_en="Grammar",
                    default_color="#222",
                    default_hotkey="shift+a",
                    is_active=True,
                ),
                ErrorType(
                    en_name="Z",
                    category_en="WordError",
                    default_color="#333",
                    default_hotkey="shift+z",
                    is_active=False,
                ),
            ]
        )
        session.commit()

    resp = client.get("/api/error-types/")
    assert resp.status_code == 200
    names = [et["en_name"] for et in resp.json()]
    # Only active; sorted by category then en_name
    assert names == ["A", "B"]

    resp_all = client.get("/api/error-types/?include_inactive=true")
    assert resp_all.status_code == 200
    assert [et["en_name"] for et in resp_all.json()] == ["A", "B", "Z"]


def test_create_error_type_trims_fields_and_persists_hotkey(client):
    payload = {
        "en_name": " Case ",
        "tt_name": " Килеш ",
        "category_en": " Grammar ",
        "category_tt": " Грамматика ",
        "default_color": "#123456",
        "default_hotkey": " shift+q ",
        "is_active": True,
    }
    resp = client.post("/api/error-types/", json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["en_name"] == "Case"
    assert body["category_en"] == "Grammar"
    assert body["default_hotkey"] == "shift+q"

    # Update hotkey and deactivate
    resp_update = client.put(
        f"/api/error-types/{body['id']}",
        json={"default_hotkey": " shift+w ", "is_active": False},
    )
    assert resp_update.status_code == 200
    updated = resp_update.json()
    assert updated["default_hotkey"] == "shift+w"
    assert updated["is_active"] is False


def test_update_nonexistent_returns_404(client):
    resp = client.put("/api/error-types/999", json={"en_name": "X"})
    assert resp.status_code == 404


def test_upsert_preferences_creates_and_updates(client):
    with db.SessionLocal() as session:
        et = ErrorType(
            en_name="Case",
            category_en="Grammar",
            default_color="#aaa",
            is_active=True,
        )
        session.add(et)
        session.commit()
        session.refresh(et)
        et_id = et.id

    # Create new preference
    resp = client.put(
        f"/api/error-types/{et_id}/preferences",
        json={"color": "#123456", "hotkey": "shift+q", "custom_name": "Custom"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["color"] == "#123456"
    assert body["hotkey"] == "shift+q"
    assert body["custom_name"] == "Custom"

    # Update preference
    resp2 = client.put(
        f"/api/error-types/{et_id}/preferences",
        json={"color": "#abcdef", "hotkey": "shift+w", "custom_name": None},
    )
    assert resp2.status_code == 200
    updated = resp2.json()
    assert updated["color"] == "#abcdef"
    assert updated["hotkey"] == "shift+w"
    assert updated["custom_name"] is None
