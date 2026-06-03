import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import AnnotationTask, Base, Category, TextSample, User
from app.services.auth import get_current_user, get_db, require_admin

ADMIN_ID = uuid.uuid4()
ANN1_ID = uuid.uuid4()
ANN2_ID = uuid.uuid4()
INACTIVE_ANN_ID = uuid.uuid4()

NOW = datetime(2026, 4, 13, 12, 0, tzinfo=timezone.utc)
SINCE = NOW - timedelta(days=7)


def override_get_db():
    session = db.SessionLocal()
    try:
        yield session
    finally:
        session.close()


def override_require_admin():
    return User(
        id=ADMIN_ID,
        username="admin",
        password_hash="x",
        role="admin",
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
    ]
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)

    with db.SessionLocal() as session:
        users = [
            User(id=ADMIN_ID, username="admin", full_name="Admin", password_hash="x", role="admin"),
            User(id=ANN1_ID, username="fayruza", full_name="Фәйрүзә", password_hash="x", role="annotator"),
            User(id=ANN2_ID, username="rafida", full_name="Рәфидә", password_hash="x", role="annotator"),
            User(
                id=INACTIVE_ANN_ID,
                username="inactive",
                full_name="Inactive",
                password_hash="x",
                role="annotator",
                is_active=False,
            ),
        ]
        session.add_all(users)

        target = Category(name="Тамгалау төп проекты")
        other = Category(name="Other project")
        session.add_all([target, other])
        session.flush()

        target_texts = [
            TextSample(content="target 1", category_id=target.id, required_annotations=1, state="pending"),
            TextSample(content="target 2", category_id=target.id, required_annotations=1, state="pending"),
            TextSample(content="target 3", category_id=target.id, required_annotations=1, state="pending"),
        ]
        other_text = TextSample(content="other", category_id=other.id, required_annotations=1, state="pending")
        session.add_all([*target_texts, other_text])
        session.flush()

        session.add_all(
            [
                # Ann1 in target project: 2 submitted, 1 in progress.
                AnnotationTask(
                    text_id=target_texts[0].id,
                    annotator_id=ANN1_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=30),
                ),
                AnnotationTask(
                    text_id=target_texts[1].id,
                    annotator_id=ANN1_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=1),
                ),
                AnnotationTask(
                    text_id=target_texts[2].id,
                    annotator_id=ANN1_ID,
                    status="in_progress",
                    updated_at=NOW - timedelta(days=2),
                ),
                # Ann2 in target project.
                AnnotationTask(
                    text_id=target_texts[0].id,
                    annotator_id=ANN2_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=3),
                ),
                # Admin review in target project.
                AnnotationTask(
                    text_id=target_texts[1].id,
                    annotator_id=ADMIN_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=1),
                ),
                # Should be excluded by project filter.
                AnnotationTask(
                    text_id=other_text.id,
                    annotator_id=ANN1_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=1),
                ),
                # Should be excluded by include_inactive=False.
                AnnotationTask(
                    text_id=target_texts[2].id,
                    annotator_id=INACTIVE_ANN_ID,
                    status="submitted",
                    updated_at=NOW - timedelta(days=1),
                ),
            ]
        )
        session.commit()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_admin] = override_require_admin
    yield
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_review_totals_filters_project_roles_and_since(client):
    response = client.get(
        "/api/reports/review-totals",
        params={
            "project_name": "Тамгалау төп проекты",
            "roles": "annotator",
            "since": SINCE.isoformat(),
            "until": NOW.isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["project_name"] == "Тамгалау төп проекты"
    assert data["category_id"] > 0
    assert data["roles"] == ["annotator"]
    assert data["totals"]["submitted_total"] == 3
    assert data["totals"]["submitted_since"] == 2
    assert data["totals"]["in_progress_total"] == 1
    assert data["totals"]["all_tasks"] == 4
    assert data["totals"]["user_count"] == 2

    rows = {row["username"]: row for row in data["rows"]}
    assert rows["fayruza"]["submitted_total"] == 2
    assert rows["fayruza"]["submitted_since"] == 1
    assert rows["fayruza"]["in_progress_total"] == 1
    assert rows["fayruza"]["all_tasks"] == 3

    assert rows["rafida"]["submitted_total"] == 1
    assert rows["rafida"]["submitted_since"] == 1
    assert rows["rafida"]["in_progress_total"] == 0
    assert rows["rafida"]["all_tasks"] == 1
    assert "admin" not in rows
    assert "inactive" not in rows


def test_review_totals_can_include_admin_and_inactive(client):
    with db.SessionLocal() as session:
        target = session.query(Category).filter(Category.name == "Тамгалау төп проекты").one()
        category_id = target.id

    response = client.get(
        "/api/reports/review-totals",
        params={
            "category_id": category_id,
            "roles": "annotator,admin",
            "since": SINCE.isoformat(),
            "until": NOW.isoformat(),
            "include_inactive": "true",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    rows = {row["username"]: row for row in data["rows"]}

    assert rows["admin"]["role"] == "admin"
    assert rows["admin"]["submitted_total"] == 1
    assert rows["admin"]["submitted_since"] == 1
    assert rows["inactive"]["is_active"] is False
    assert rows["inactive"]["submitted_total"] == 1
    assert data["totals"]["submitted_total"] == 5
    assert data["totals"]["submitted_since"] == 4
    assert data["totals"]["user_count"] == 4


def test_review_totals_requires_admin(client):
    def non_admin_user():
        return User(
            id=ANN1_ID,
            username="fayruza",
            password_hash="x",
            role="annotator",
            is_active=True,
        )

    app.dependency_overrides.pop(require_admin, None)
    app.dependency_overrides[get_current_user] = non_admin_user

    response = client.get(
        "/api/reports/review-totals",
        params={"project_name": "Тамгалау төп проекты"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Admin privileges required"


def test_review_totals_validates_filter_and_window(client):
    missing_scope = client.get("/api/reports/review-totals")
    assert missing_scope.status_code == 400
    assert "exactly one" in missing_scope.json()["detail"]

    invalid_window = client.get(
        "/api/reports/review-totals",
        params={
            "project_name": "Тамгалау төп проекты",
            "since": NOW.isoformat(),
            "until": (NOW - timedelta(days=1)).isoformat(),
        },
    )
    assert invalid_window.status_code == 400
    assert "since must be less than or equal to until" in invalid_window.json()["detail"]
