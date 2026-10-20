from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# Make backend/app importable as `app`.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.database import Base  # noqa: E402
from app import models  # noqa: E402,F401


def _test_url() -> str:
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL is not set. Load it from .env.test first.")
    # Fail closed: tests must never connect to the development database.
    if not url.rstrip("/").endswith("/health11_test"):
        pytest.fail(
            "Refusing to run database tests: TEST_DATABASE_URL must target "
            "the dedicated /health11_test database."
        )
    return url


@pytest.fixture(scope="session")
def engine():
    db_engine = create_engine(_test_url(), pool_pre_ping=True)
    with db_engine.connect() as conn:
        db_name = conn.exec_driver_sql("SELECT current_database()").scalar_one()
        if db_name != "health11_test":
            pytest.fail(f"Refusing database {db_name!r}; expected 'health11_test'.")
    yield db_engine
    db_engine.dispose()


@pytest.fixture()
def db_session(engine):
    # Each test runs in a transaction that is rolled back, so test rows don't persist.
    connection = engine.connect()
    outer_transaction = connection.begin()
    TestingSession = sessionmaker(
        bind=connection, class_=Session, expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        outer_transaction.rollback()
        connection.close()


# AI settings that tests start from, whatever the developer's .env says
# (a real key or AI_PROVIDER=gemini there must never change a test or be used).
SAFE_AI_SETTINGS = {
    "ai_provider": "anthropic",
    "anthropic_api_key": None,
    "anthropic_model": None,
    "gemini_api_key": None,
    "gemini_model": None,
    "gemini_free_tier": True,
    "gemini_api_version": "v1",
    "groq_api_key": None,
    "groq_model": None,
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": None,
    # E-mail: off unless a test turns it on (with a fake sender); a real
    # SMTP_* in the developer's .env is never used.
    "smtp_host": None,
    "smtp_username": None,
    "smtp_password": None,
    "smtp_from": None,
    "smtp_security": "starttls",
    # Weather: on, but tests answer with a fake transport (no internet).
    "weather_enabled": True,
}


@pytest.fixture(autouse=True)
def no_real_ai_settings(monkeypatch):
    from app.config import get_settings

    for name, value in SAFE_AI_SETTINGS.items():
        monkeypatch.setattr(get_settings(), name, value)
        # Settings built inside a test must not pick them up from the environment either.
        monkeypatch.delenv(name.upper(), raising=False)


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Tests never reach the internet. In-process test clients and
    httpx.MockTransport still work; a real HTTP request fails the test."""
    import httpx

    def blocked(self, request):
        raise httpx.ConnectError(
            f"Tests must not make real network requests (tried {request.url.host})", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked)
