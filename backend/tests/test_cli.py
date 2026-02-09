import os
from types import SimpleNamespace

import pytest
from sqlalchemy.engine import make_url

os.environ.setdefault("DATABASE__URL", "sqlite:///:memory:")
os.environ.setdefault("SKIP_CREATE_ALL", "1")

import app.cli as cli_module


def test_configure_cli_uses_database_url_override(monkeypatch: pytest.MonkeyPatch):
    called = []
    monkeypatch.setattr(cli_module, "configure_engine", lambda url: called.append(url))

    cli_module.configure_cli(database_url="sqlite:///override.db")

    assert called == ["sqlite:///override.db"]


def test_configure_cli_builds_effective_url_from_partial_overrides(monkeypatch: pytest.MonkeyPatch):
    settings = SimpleNamespace(
        database=SimpleNamespace(
            url="postgresql+psycopg://base_user:base_pass@localhost:5432/gec?sslmode=require"
        )
    )
    monkeypatch.setattr(cli_module, "get_settings", lambda: settings)

    called = []
    monkeypatch.setattr(cli_module, "configure_engine", lambda url: called.append(url))

    cli_module.configure_cli(
        database_url=None,
        db_host="db.internal",
        db_port=5439,
        db_name="gec_prod",
        db_user="annotator",
        db_password="secret",
    )

    assert len(called) == 1
    parsed = make_url(called[0])
    assert parsed.drivername == "postgresql+psycopg"
    assert parsed.username == "annotator"
    assert parsed.password == "secret"
    assert parsed.host == "db.internal"
    assert parsed.port == 5439
    assert parsed.database == "gec_prod"
    assert parsed.query.get("sslmode") == "require"


def test_configure_cli_does_nothing_without_overrides(monkeypatch: pytest.MonkeyPatch):
    called = []
    monkeypatch.setattr(cli_module, "configure_engine", lambda url: called.append(url))

    cli_module.configure_cli(
        database_url=None,
        db_host=None,
        db_port=None,
        db_name=None,
        db_user=None,
        db_password=None,
    )

    assert called == []
