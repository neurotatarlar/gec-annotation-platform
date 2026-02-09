import os

import pytest

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.services.auth as auth_service


class DummySession:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_get_db_closes_session_when_generator_is_closed(monkeypatch: pytest.MonkeyPatch):
    dummy = DummySession()
    monkeypatch.setattr(auth_service, "SessionLocal", lambda: dummy)

    gen = auth_service.get_db()
    yielded = next(gen)
    assert yielded is dummy
    assert not dummy.closed

    gen.close()
    assert dummy.closed


def test_get_db_closes_session_when_exception_is_thrown(monkeypatch: pytest.MonkeyPatch):
    dummy = DummySession()
    monkeypatch.setattr(auth_service, "SessionLocal", lambda: dummy)

    gen = auth_service.get_db()
    next(gen)

    with pytest.raises(RuntimeError, match="boom"):
        gen.throw(RuntimeError("boom"))

    assert dummy.closed
