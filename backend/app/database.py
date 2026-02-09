"""
SQLAlchemy engine/session setup plus scoped helpers for transactional work.
"""

from contextlib import contextmanager

from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import scoped_session, sessionmaker

from .config import get_settings

engine = None
SessionLocal = None


def configure_engine(
    database_url: str,
    *,
    pool_size: Optional[int] = None,
    max_overflow: Optional[int] = None,
) -> None:
    """Configure the global SQLAlchemy engine/session factory."""
    settings = get_settings()
    resolved_pool = pool_size if pool_size is not None else settings.database.pool_size
    resolved_overflow = max_overflow if max_overflow is not None else settings.database.max_overflow

    global engine, SessionLocal
    if database_url.startswith("sqlite"):
        engine = create_engine(
            database_url,
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    else:
        engine = create_engine(
            database_url,
            pool_size=resolved_pool,
            max_overflow=resolved_overflow,
            future=True,
        )
    SessionLocal = scoped_session(sessionmaker(bind=engine, autoflush=False, autocommit=False))


_default_settings = get_settings()
configure_engine(
    _default_settings.database.url,
    pool_size=_default_settings.database.pool_size,
    max_overflow=_default_settings.database.max_overflow,
)


@contextmanager
def session_scope():
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
