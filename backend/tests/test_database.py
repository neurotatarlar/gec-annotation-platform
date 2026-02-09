import os

import pytest
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.database as db
from app.models import Base, User


@pytest.fixture(autouse=True)
def setup_db():
    db.configure_engine("sqlite:///:memory:")
    tables = [User.__table__]
    Base.metadata.drop_all(bind=db.engine, tables=tables)
    Base.metadata.create_all(bind=db.engine, tables=tables)
    yield
    Base.metadata.drop_all(bind=db.engine, tables=tables)


def test_configure_engine_uses_static_pool_for_sqlite():
    db.configure_engine("sqlite:///:memory:")

    assert isinstance(db.engine.pool, StaticPool)
    assert db.SessionLocal is not None


def test_session_scope_commits_on_success():
    with db.session_scope() as session:
        session.add(User(username="alice", password_hash="x"))

    with db.session_scope() as session:
        count = session.query(User).count()
    assert count == 1


def test_session_scope_rolls_back_on_error():
    with pytest.raises(RuntimeError, match="boom"):
        with db.session_scope() as session:
            session.add(User(username="bob", password_hash="x"))
            raise RuntimeError("boom")

    with db.session_scope() as session:
        count = session.query(User).count()
    assert count == 0
