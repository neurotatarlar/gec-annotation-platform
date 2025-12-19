import os
import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import (
    AnnotationTask,
    Base,
    Category,
    CrossValidationResult,
    ErrorType,
    SkippedText,
    TextSample,
    User,
)
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
        username="dashboarder",
        password_hash="x",
        role="annotator",
        is_active=True,
    )


@pytest.fixture(autouse=True)
def setup_db():
    db.configure_engine("sqlite:///:memory:")
    tables = [
        User.__table__,
        Category.__table__,
        TextSample.__table__,
        AnnotationTask.__table__,
        SkippedText.__table__,
        ErrorType.__table__,
        CrossValidationResult.__table__,
    ]
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)

    with db.SessionLocal() as session:
        user = User(
            id=TEST_USER_ID,
            username="dashboarder",
            password_hash="x",
            role="annotator",
            is_active=True,
        )
        other = User(
            id=uuid.uuid4(),
            username="other",
            password_hash="x",
            role="annotator",
            is_active=True,
        )
        session.add_all([user, other])
        category = Category(name="Demo")
        session.add(category)
        session.flush()
        error_type = ErrorType(en_name="OTHER", default_color="#f97316", is_active=True)
        session.add(error_type)
        texts = [
            TextSample(content="text submitted", category_id=category.id, required_annotations=1, state="awaiting_cross_validation"),
            TextSample(content="text skipped", category_id=category.id, required_annotations=1, state="skip"),
            TextSample(content="text trashed", category_id=category.id, required_annotations=1, state="trash"),
        ]
        session.add_all(texts)
        session.flush()
        session.add_all(
            [
                AnnotationTask(text_id=texts[0].id, annotator_id=other.id, status="submitted", updated_at=datetime.utcnow()),
                AnnotationTask(text_id=texts[1].id, annotator_id=other.id, status="skip", updated_at=datetime.utcnow()),
                AnnotationTask(text_id=texts[2].id, annotator_id=other.id, status="trash", updated_at=datetime.utcnow()),
            ]
        )
        session.add_all(
            [
                SkippedText(text_id=texts[1].id, annotator_id=other.id, flag_type="skip"),
                SkippedText(text_id=texts[2].id, annotator_id=other.id, flag_type="trash"),
            ]
        )
        session.commit()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    yield
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_dashboard_history_includes_terminal_tasks_from_any_annotator(client):
    resp = client.get("/api/dashboard/history", params={"limit": 50, "offset": 0})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    statuses = {item["status"] for item in data["items"]}
    assert {"submitted", "skip", "trash"}.issubset(statuses)


def test_dashboard_activity_includes_terminal_events(client):
    resp = client.get("/api/dashboard/activity", params={"limit": 50, "offset": 0})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    seen_statuses = {item["status"] for item in data["items"]}
    assert {"submitted", "skip", "trash"}.issubset(seen_statuses)
