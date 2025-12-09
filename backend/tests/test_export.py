import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.sqlite import JSON

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.main import app
from app.models import Annotation, AnnotationTask, Base, Category, ErrorType, TextSample, User
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
        Annotation.__table__,
        ErrorType.__table__,
    ]
    Annotation.__table__.c.payload.type = JSON()
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)

    with db.SessionLocal() as session:
        user = User(
            id=TEST_USER_ID,
            username="tester",
            password_hash="x",
            role="annotator",
            is_active=True,
        )
        session.add(user)
        category = Category(name="ExportCat")
        session.add(category)
        session.flush()
        submitted_text = TextSample(content="hello world", category_id=category.id, required_annotations=1)
        trashed_text = TextSample(content="trash me", category_id=category.id, required_annotations=1, state="trash")
        session.add_all([submitted_text, trashed_text])
        error_type = ErrorType(en_name="ART", default_color="#f97316", is_active=True)
        session.add(error_type)
        session.flush()
        session.add(
            AnnotationTask(
                text_id=submitted_text.id,
                annotator_id=TEST_USER_ID,
                status="submitted",
            )
        )
        session.add(
            AnnotationTask(
                text_id=trashed_text.id,
                annotator_id=TEST_USER_ID,
                status="trash",
            )
        )
        session.add(
            Annotation(
                text_id=submitted_text.id,
                author_id=TEST_USER_ID,
                start_token=0,
                end_token=0,
                replacement="hi",
                error_type_id=error_type.id,
                payload={
                    "operation": "replace",
                    "text_tokens": ["hello", "world"],
                    "text_tokens_sha256": "x",
                    "after_tokens": [{"id": "a1", "text": "hi", "origin": "base"}],
                },
            )
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


def test_export_includes_only_submitted(client):
    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    body = resp.text.strip()
    assert "S hello world" in body
    assert "A 0 0|||ART|||hi|||REQUIRED|||-NONE-|||0" in body
    assert "trash me" not in body


def test_export_includes_noop_when_no_annotations(client):
    with db.SessionLocal() as session:
        category = session.query(Category).filter_by(name="ExportCat").one()
        text = TextSample(content="plain sample", category_id=category.id, required_annotations=1)
        session.add(text)
        session.flush()
        session.add(
          AnnotationTask(
            text_id=text.id,
            annotator_id=TEST_USER_ID,
            status="submitted",
          )
        )
        session.commit()

    resp = client.get("/api/texts/export")
    assert resp.status_code == 200, resp.text
    body = resp.text
    assert "S plain sample" in body
    assert "A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0" in body


def test_export_filters_by_category(client):
    resp = client.get("/api/texts/export", params={"category_ids": "999"})
    assert resp.status_code == 200, resp.text
    assert resp.text.strip() == ""
