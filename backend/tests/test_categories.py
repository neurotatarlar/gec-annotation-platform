import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Base, Category, User
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
    from app.models import TextSample  # import here to avoid circular import in test discovery

    db.configure_engine("sqlite:///:memory:")
    Base.metadata.drop_all(bind=db.engine, tables=[User.__table__, Category.__table__, TextSample.__table__])
    Base.metadata.create_all(bind=db.engine, tables=[User.__table__, Category.__table__, TextSample.__table__])

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

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    yield
    Base.metadata.drop_all(bind=db.engine, tables=[User.__table__, Category.__table__, TextSample.__table__])
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_categories_order_by_created_desc_and_include_hidden_flag(client):
    with db.SessionLocal() as session:
        older = Category(name="Old", description=None, created_at=datetime.now(timezone.utc) - timedelta(days=1))
        newer = Category(name="New", description=None, is_hidden=True)
        session.add_all([older, newer])
        session.commit()

    resp = client.get("/api/categories/")
    assert resp.status_code == 200
    data = resp.json()
    assert [c["name"] for c in data] == ["New", "Old"]
    assert data[0]["is_hidden"] is True
    assert data[1]["is_hidden"] is False


def test_update_category_hides_and_unhides(client):
    with db.SessionLocal() as session:
        cat = Category(name="Demo", description=None)
        session.add(cat)
        session.commit()
        session.refresh(cat)
        cat_id = cat.id

    resp_hide = client.put(f"/api/categories/{cat_id}", json={"is_hidden": True})
    assert resp_hide.status_code == 200
    assert resp_hide.json()["is_hidden"] is True

    resp_show = client.put(f"/api/categories/{cat_id}", json={"is_hidden": False})
    assert resp_show.status_code == 200
    assert resp_show.json()["is_hidden"] is False
