import os

import pytest

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

from app.config import get_settings


@pytest.fixture(autouse=True)
def clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_get_settings_defaults_when_env_not_set(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.delenv("DATABASE__URL", raising=False)
    monkeypatch.delenv("DATABASE__POOL_SIZE", raising=False)
    monkeypatch.delenv("SECURITY__SECRET_KEY", raising=False)
    monkeypatch.chdir(tmp_path)

    settings = get_settings()

    assert settings.database.url == "postgresql+psycopg://postgres:postgres@localhost:5432/gec"
    assert settings.database.pool_size == 10
    assert settings.security.secret_key == "change-me"
    assert "http://localhost:5173" in settings.allowed_origins


def test_get_settings_reads_nested_env_overrides(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATABASE__URL", "sqlite:///override.db")
    monkeypatch.setenv("DATABASE__POOL_SIZE", "42")
    monkeypatch.setenv("SECURITY__SECRET_KEY", "unit-test-secret")

    settings = get_settings()

    assert settings.database.url == "sqlite:///override.db"
    assert settings.database.pool_size == 42
    assert settings.security.secret_key == "unit-test-secret"


def test_get_settings_is_cached_until_cache_clear(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SECURITY__SECRET_KEY", "first-secret")
    first = get_settings()

    monkeypatch.setenv("SECURITY__SECRET_KEY", "second-secret")
    second = get_settings()
    assert first is second
    assert second.security.secret_key == "first-secret"

    get_settings.cache_clear()
    refreshed = get_settings()
    assert refreshed.security.secret_key == "second-secret"
