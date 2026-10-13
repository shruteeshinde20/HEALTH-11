"""Phase 10 (group 5): own profile, password change, and the model
parameters shown on the Settings page."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import _password_hash
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, RefreshToken, User, UserRole
from app.services.model_parameters import SPECS

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


def register(client, name="Profile Org"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin Person",
        "email": "admin@example.com", "password": PASSWORD}).json()
    return body, {"Authorization": f"Bearer {body['access_token']}"}


def login(client, slug, password, email="admin@example.com"):
    return client.post(f"{API}/auth/login", json={"organization_slug": slug, "email": email, "password": password})


def staff_member(client, db_session, body):
    db_session.add(User(organization_id=body["organization"]["id"], email="staff@example.com",
                        full_name="Staff", password_hash=_password_hash(PASSWORD),
                        role=UserRole.STAFF_USER, is_active=True))
    db_session.flush()
    token = login(client, body["organization"]["slug"], PASSWORD, "staff@example.com").json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_users_change_their_own_name_only(client, db_session):
    body, h = register(client)
    changed = client.patch(f"{API}/auth/me", headers=h, json={"full_name": "  Asha Rao  "})
    assert changed.status_code == 200 and changed.json()["full_name"] == "Asha Rao"
    assert client.get(f"{API}/auth/me", headers=h).json()["full_name"] == "Asha Rao"
    # Role and email are for Administrators, through /users.
    assert client.patch(f"{API}/auth/me", headers=h, json={"full_name": "X", "role": "Staff User"}).status_code == 422
    assert client.patch(f"{API}/auth/me", headers=h, json={"full_name": " a "}).status_code == 422
    assert client.patch(f"{API}/auth/me", json={"full_name": "Nobody"}).status_code == 401
    staff = staff_member(client, db_session, body)
    assert client.patch(f"{API}/auth/me", headers=staff, json={"full_name": "Staff Two"}).status_code == 200
    audit = db_session.scalars(select(AuditLog).where(AuditLog.action == "user.profile_updated")).all()
    assert len(audit) == 2


def test_password_change_signs_out_other_sessions(client, db_session):
    body, h = register(client)
    slug = body["organization"]["slug"]
    other_session = login(client, slug, PASSWORD).json()["refresh_token"]

    changed = client.post(f"{API}/auth/change-password", headers=h,
                          json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert changed.status_code == 200, changed.text
    tokens = changed.json()
    assert tokens["access_token"] and tokens["refresh_token"] and tokens["user"]["email"] == "admin@example.com"
    # The new tokens work; every older refresh token is revoked.
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}).status_code == 200
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": other_session}).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 200
    # Only the new password logs in.
    assert login(client, slug, PASSWORD).status_code == 401
    assert login(client, slug, NEW_PASSWORD).status_code == 200
    entry = db_session.scalars(select(AuditLog).where(AuditLog.action == "user.password_changed")).one()
    assert "Strong" not in str(entry.details)
    assert db_session.scalars(select(RefreshToken).where(RefreshToken.revoked_at.is_(None))).all()


def test_password_change_checks(client, db_session):
    _body, h = register(client, "Checks Org")
    wrong = client.post(f"{API}/auth/change-password", headers=h,
                        json={"current_password": "not-it", "new_password": NEW_PASSWORD})
    # 400, not 401, so the website does not treat it as a lost session.
    assert wrong.status_code == 400
    assert wrong.json()["error"]["message"] == "The current password is not correct"
    same = client.post(f"{API}/auth/change-password", headers=h,
                       json={"current_password": PASSWORD, "new_password": PASSWORD})
    assert same.status_code == 400
    weak = client.post(f"{API}/auth/change-password", headers=h,
                       json={"current_password": PASSWORD, "new_password": "weakpassword1"})
    assert weak.status_code == 422
    assert client.post(f"{API}/auth/change-password",
                       json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}).status_code == 401
    assert db_session.scalars(select(AuditLog).where(AuditLog.action == "auth.password_change_failed")).all()


def test_wrong_current_passwords_are_rate_limited(client, db_session):
    _body, h = register(client, "Limit Org")
    for _ in range(5):   # LOGIN_MAX_FAILURES_PER_ACCOUNT default
        assert client.post(f"{API}/auth/change-password", headers=h,
                           json={"current_password": "guess", "new_password": NEW_PASSWORD}).status_code == 400
    limited = client.post(f"{API}/auth/change-password", headers=h,
                          json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert limited.status_code == 429 and limited.headers.get("retry-after")


def test_parameter_specs_and_range_checks(client, db_session):
    body, h = register(client, "Parameter Org")
    staff = staff_member(client, db_session, body)
    specs = client.get(f"{API}/parameters/specs", headers=staff).json()
    assert [s["name"] for s in specs] == sorted(SPECS)
    walking = next(s for s in specs if s["name"] == "speed_ambulatory_m_per_s")
    assert walking == {"name": "speed_ambulatory_m_per_s", "default": 1.2, "unit": "m/s",
                       "minimum": 0.05, "maximum": 5.0, "meaning": SPECS["speed_ambulatory_m_per_s"].meaning}

    def post(value, name="speed_ambulatory_m_per_s", headers=h):
        return client.post(f"{API}/parameters", headers=headers, json={
            "name": name, "value": value, "unit": "m/s", "source": "assumed, to be validated"})

    for bad in ("fast", "0", "5.1", "nan", "inf"):
        refused = post(bad)
        assert refused.status_code == 422, bad
        assert refused.json()["error"]["message"] == "speed_ambulatory_m_per_s must be a number between 0.05 and 5 (m/s)"
    assert post("1.0", headers=staff).status_code == 403
    saved = post("1.0")
    assert saved.status_code == 201
    pid = saved.json()["id"]
    assert client.patch(f"{API}/parameters/{pid}", headers=h, json={"value": "9"}).status_code == 422
    assert client.patch(f"{API}/parameters/{pid}", headers=h,
                        json={"value": "1.1", "source": "NFPA handbook, table 4"}).json()["value"] == "1.1"
    # Renaming onto another model parameter checks that one's range.
    assert client.patch(f"{API}/parameters/{pid}", headers=h, json={"name": "smoke_blocking_severity"}).status_code == 200
    assert client.patch(f"{API}/parameters/{pid}", headers=h, json={"name": "priority_weight_hazard"}).status_code == 422
    # Other parameters (not read by the models) stay free text.
    assert post("two doors", name="exit_capacity_note").status_code == 201
