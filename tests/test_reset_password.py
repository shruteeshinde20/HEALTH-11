"""scripts/reset_password.py: a new password for an account, by the server operator.

Runs against health11_test inside the test's rolled-back transaction.
"""

import importlib.util
import time
from pathlib import Path

import pytest
from app.db_session import get_db
from app.main import app
from app.models import AuditLog
from fastapi.testclient import TestClient
from sqlalchemy import select

API = "/api/v1"
OLD = "OldPassword!2345"
NEW = "BrandNew-Pass-9876"
SLUG = "reset-test-org"


def _module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "reset_password.py"
    spec = importlib.util.spec_from_file_location("reset_password", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _module()


@pytest.fixture
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def account(client):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Reset Test Org", "full_name": "Admin", "email": "admin@example.com",
        "password": OLD}).json()
    assert body["organization"]["slug"] == SLUG
    return body


def login(client, password, email="admin@example.com", slug=SLUG):
    return client.post(f"{API}/auth/login", json={
        "organization_slug": slug, "email": email, "password": password})


def test_new_password_works_and_the_old_one_does_not(client, db_session, account):
    tool.reset_password(db_session, SLUG, "Admin@Example.com ", NEW)
    assert login(client, NEW).status_code == 200
    assert login(client, OLD).status_code == 401


def test_earlier_logins_are_ended(client, db_session, account):
    old_refresh = account["refresh_token"]
    # Tokens carry their issue time in whole seconds; move past that second.
    time.sleep(1.1)
    tool.reset_password(db_session, SLUG, "admin@example.com", NEW)
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": old_refresh}).status_code == 401
    old_access = {"Authorization": f"Bearer {account['access_token']}"}
    assert client.get(f"{API}/hospitals", headers=old_access).status_code == 401


def test_the_failed_login_lockout_is_cleared(client, db_session, account):
    for _ in range(5):
        assert login(client, "Wrong-Password-111").status_code == 401
    assert login(client, OLD).status_code == 429   # locked out
    tool.reset_password(db_session, SLUG, "admin@example.com", NEW)
    assert login(client, NEW).status_code == 200


def test_it_is_written_to_the_audit_log(db_session, account):
    tool.reset_password(db_session, SLUG, "admin@example.com", NEW)
    actions = db_session.scalars(select(AuditLog.action).where(
        AuditLog.organization_id == account["organization"]["id"])).all()
    assert tool.AUDIT_ACTION in actions


@pytest.mark.parametrize("slug, email, password, message", [
    ("no-such-org", "admin@example.com", NEW, "No organization"),
    (SLUG, "nobody@example.com", NEW, "No account"),
    (SLUG, "admin@example.com", "short", "at least 12 characters"),
    (SLUG, "admin@example.com", "nouppercase-123!", "uppercase"),
])
def test_bad_requests_change_nothing(client, db_session, account, slug, email, password, message):
    with pytest.raises(tool.ResetError, match=message):
        tool.reset_password(db_session, slug, email, password)
    assert login(client, OLD).status_code == 200


def test_the_list_shows_ids_emails_and_roles_but_no_password_data(db_session, account):
    rows = [row for row in tool.list_accounts(db_session) if row["organization_id"] == SLUG]
    assert rows == [{"organization_id": SLUG, "organization": "Reset Test Org",
                     "users": [{"email": "admin@example.com", "role": "Administrator", "active": True}]}]


def test_the_command_refuses_the_test_databases(monkeypatch):
    import os

    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "database_url", os.environ["TEST_DATABASE_URL"])
    with pytest.raises(tool.ResetError, match="automated tests"):
        tool.main(["--list"])
