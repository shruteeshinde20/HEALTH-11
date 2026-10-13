"""Build step 15: security and quality review.

- A password change or reset ends every other session at once.
- A refresh token that comes back after it was replaced ends every session
  of that user (it was probably copied); logout can be repeated safely.
- Request size limit and security headers on every API response.
- Passwords longer than bcrypt can check are refused cleanly at login.
- The database keeps updated_at current and has the same defaults as the code.
"""

import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update

from app import auth
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, Hazard, RefreshToken

API = "/api/v1"
PASSWORD = "StrongPassword!234"
NEW_PASSWORD = "AnotherStrong#5678"


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


def register(client, name="Security Org"):
    return client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin Person",
        "email": "admin@example.com", "password": PASSWORD}).json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def login(client, slug, password=PASSWORD, email="admin@example.com"):
    return client.post(f"{API}/auth/login", json={"organization_slug": slug, "email": email, "password": password})


# --- Sessions end when the password changes ----------------------------------------------------

def test_password_change_ends_other_access_tokens_at_once(client, db_session):
    body = register(client)
    slug = body["organization"]["slug"]
    laptop = login(client, slug).json()
    time.sleep(1.1)   # token times are whole seconds; the change must come in a later second
    changed = client.post(f"{API}/auth/change-password", headers=bearer(body["access_token"]),
                          json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}).json()
    # Before: still valid for up to 30 minutes. Now: refused straight away.
    for old in (laptop["access_token"], body["access_token"]):
        refused = client.get(f"{API}/auth/me", headers=bearer(old))
        assert refused.status_code == 401
        assert refused.json()["error"]["message"] == "This session has ended; please sign in again"
    assert client.get(f"{API}/auth/me", headers=bearer(changed["access_token"])).status_code == 200
    assert login(client, slug, NEW_PASSWORD).status_code == 200


def test_administrator_password_reset_ends_the_users_sessions(client, db_session):
    body = register(client, "Reset Org")
    admin = bearer(body["access_token"])
    member = client.post(f"{API}/users", headers=admin, json={
        "full_name": "Ravi", "email": "ravi@example.com", "role": "Emergency Commander",
        "password": "FirstPassword#123"}).json()
    ravi = login(client, body["organization"]["slug"], "FirstPassword#123", "ravi@example.com").json()
    time.sleep(1.1)
    assert client.patch(f"{API}/users/{member['id']}", headers=admin,
                        json={"password": "ResetPassword#456"}).status_code == 200
    assert client.get(f"{API}/hospitals", headers=bearer(ravi["access_token"])).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": ravi["refresh_token"]}).status_code == 401
    # The Administrator's own session is not affected.
    assert client.get(f"{API}/hospitals", headers=admin).status_code == 200


# --- Refresh token reuse and logout ------------------------------------------------------------

def test_a_replaced_refresh_token_coming_back_ends_every_session(client, db_session, monkeypatch):
    body = register(client, "Reuse Org")
    slug = body["organization"]["slug"]
    other_device = login(client, slug).json()
    stolen = body["refresh_token"]
    renewed = client.post(f"{API}/auth/refresh", json={"refresh_token": stolen}).json()
    assert renewed["access_token"]

    # Within the grace period (two tabs renewing together) it is only refused.
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": stolen}).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": other_device["refresh_token"]}).status_code == 200

    # Later, it means the token was copied: every session of the user ends.
    monkeypatch.setattr(auth, "REUSE_GRACE_SECONDS", -1)
    time.sleep(1.1)
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": stolen}).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": renewed["refresh_token"]}).status_code == 401
    assert client.get(f"{API}/auth/me", headers=bearer(renewed["access_token"])).status_code == 401
    assert db_session.scalars(select(AuditLog).where(AuditLog.action == "auth.refresh_token_reused")).one()
    # Signing in again works.
    assert login(client, slug).status_code == 200


def test_logged_out_tokens_are_refused_without_ending_other_sessions(client, db_session, monkeypatch):
    body = register(client, "Logout Org")
    slug = body["organization"]["slug"]
    phone = login(client, slug).json()
    assert client.post(f"{API}/auth/logout", json={"refresh_token": body["refresh_token"]}).status_code == 204
    # Logging out twice (a double click, two tabs) is fine.
    assert client.post(f"{API}/auth/logout", json={"refresh_token": body["refresh_token"]}).status_code == 204
    monkeypatch.setattr(auth, "REUSE_GRACE_SECONDS", -1)
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": body["refresh_token"]}).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": phone["refresh_token"]}).status_code == 200
    reasons = {t.revoked_reason for t in db_session.scalars(select(RefreshToken)) if t.revoked_at}
    assert reasons == {"logout", "rotated"}
    assert client.post(f"{API}/auth/logout", json={"refresh_token": "not-a-token-at-all-xxxxxx"}).status_code == 401


# --- Request size and headers ------------------------------------------------------------------

def test_large_requests_are_refused_with_413(client, db_session):
    body = register(client, "Size Org")
    headers = bearer(body["access_token"])
    big = "x" * (6 * 1024 * 1024 + 1)
    declared = client.post(f"{API}/hospitals", headers={**headers, "Content-Type": "application/json"},
                           content=('{"name": "' + big + '"}').encode())
    assert declared.status_code == 413
    assert declared.json() == {"error": {"code": "PAYLOAD_TOO_LARGE", "message": "The request is too large"}}

    def chunks():   # no Content-Length: counted while reading
        yield b'{"name": "'
        for _ in range(7):
            yield b"x" * (1024 * 1024)
        yield b'"}'

    streamed = client.post(f"{API}/hospitals", headers={**headers, "Content-Type": "application/json"},
                           content=chunks())
    assert streamed.status_code == 413
    assert streamed.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    # Normal requests are unaffected.
    assert client.post(f"{API}/hospitals", headers=headers, json={"name": "Fine", "timezone": "UTC"}).status_code == 201


def test_security_headers_on_api_responses(client, db_session):
    body = register(client, "Header Org")
    for response in (client.get(f"{API}/auth/me", headers=bearer(body["access_token"])),
                     client.get(f"{API}/hospitals"),        # errors too
                     client.get("/health")):
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert response.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert response.headers["cache-control"] == "no-store"
    # The interactive API docs keep working (they load their own scripts).
    docs = client.get("/docs")
    assert docs.status_code == 200 and "content-security-policy" not in docs.headers


# --- Passwords and bcrypt ----------------------------------------------------------------------

def test_passwords_longer_than_bcrypt_can_check_get_a_normal_answer(client, db_session):
    body = register(client, "Bcrypt Org")
    too_long = "Aa1!" + "é" * 60          # 64 characters, 124 bytes
    response = login(client, body["organization"]["slug"], too_long)
    assert response.status_code == 401
    weak = client.post(f"{API}/auth/change-password", headers=bearer(body["access_token"]),
                       json={"current_password": PASSWORD, "new_password": too_long})
    assert weak.status_code == 422


# --- Database: updated_at and defaults ---------------------------------------------------------

def test_updated_at_changes_even_for_bulk_updates(client, db_session):
    body = register(client, "Clock Org")
    headers = bearer(body["access_token"])
    hospital = client.post(f"{API}/hospitals", headers=headers, json={"name": "H", "timezone": "UTC"}).json()
    building = client.post(f"{API}/buildings", headers=headers, json={"hospital_id": hospital["id"], "name": "B"}).json()
    floor = client.post(f"{API}/floors", headers=headers, json={"building_id": building["id"], "floor_number": 0,
                                                                "name": "G"}).json()
    node = client.post(f"{API}/nodes", headers=headers, json={"floor_id": floor["id"], "name": "W", "type": "ward"}).json()
    scenario = client.post(f"{API}/scenarios", headers=headers, json={"name": "S", "hazards": [
        {"name": "F", "type": "fire", "origin_node_id": node["id"]}]}).json()
    before = db_session.scalars(select(Hazard).where(Hazard.scenario_id == scenario["id"])).one().updated_at
    # A bulk UPDATE (as used when a scenario's hazards are replaced) bypasses the ORM.
    db_session.execute(update(Hazard).where(Hazard.scenario_id == scenario["id"]).values(severity=5))
    db_session.expire_all()
    after = db_session.scalars(select(Hazard).where(Hazard.scenario_id == scenario["id"])).one().updated_at
    assert after > before


def test_database_defaults_match_the_code(client, db_session):
    body = register(client, "Default Org")
    org_id = body["organization"]["id"]
    row = db_session.execute(text(
        "INSERT INTO hospitals (organization_id, name) VALUES (:org, 'Raw') RETURNING timezone, created_at"
    ), {"org": org_id}).one()
    assert row.timezone == "UTC"
    user = db_session.execute(text(
        "INSERT INTO users (organization_id, email, password_hash, full_name, role) "
        "VALUES (:org, 'raw@example.com', 'x', 'Raw', 'staff_user') RETURNING is_active, tokens_valid_after"
    ), {"org": org_id}).one()
    assert user.is_active is True and user.tokens_valid_after is None


# --- Logs --------------------------------------------------------------------------------------

def test_tokens_are_hidden_in_server_logs(caplog):
    import logging

    from app.logging_config import RedactTokens, configure_logging, redact_tokens

    assert redact_tokens('"WebSocket /api/v1/ws/simulations/5?token=eyJ.abc.def&speed=10" [accepted]') == \
        '"WebSocket /api/v1/ws/simulations/5?token=[hidden]&speed=10" [accepted]'
    assert redact_tokens("/x?a=1&refresh_token=abc") == "/x?a=1&refresh_token=[hidden]"
    assert redact_tokens("no secrets here, token count 3") == "no secrets here, token count 3"

    configure_logging("INFO")
    uvicorn_error = logging.getLogger("uvicorn.error")
    assert any(isinstance(f, RedactTokens) for f in uvicorn_error.filters)
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, '%s - "WebSocket %s" [accepted]',
                               ("127.0.0.1:5000", "/api/v1/ws/simulations/5?token=secret-value&speed=10"), None)
    RedactTokens().filter(record)
    assert "secret-value" not in record.getMessage() and "token=[hidden]" in record.getMessage()
