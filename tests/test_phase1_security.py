"""Regression tests for Phase 1 (foundation and authentication hardening).

Each test names the defect it guards against (see ANALYSIS.md numbering).
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.auth import _password_hash
from app.config import PROJECT_ROOT, Settings, get_settings
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, Building, Floor, Hospital, User, UserRole

PASSWORD = "StrongPassword!234"


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


def register(client, organization_name, email="admin@example.com"):
    response = client.post(
        "/api/v1/auth/register-organization",
        json={
            "organization_name": organization_name,
            "full_name": "Test Administrator",
            "email": email,
            "password": PASSWORD,
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    return {
        "org_id": body["organization"]["id"],
        "slug": body["organization"]["slug"],
        "user_id": body["user"]["id"],
        "headers": {"Authorization": f"Bearer {body['access_token']}"},
    }


def login(client, slug, email, password=PASSWORD):
    return client.post(
        "/api/v1/auth/login",
        json={"organization_slug": slug, "email": email, "password": password},
    )


def add_member(client, db_session, org, role, email):
    """Create a user with `role` in `org` and sign in through the real API."""
    db_session.add(
        User(
            organization_id=org["org_id"],
            email=email,
            password_hash=_password_hash(PASSWORD),
            full_name=f"{role.value} user",
            role=role,
            is_active=True,
        )
    )
    db_session.flush()
    response = login(client, org["slug"], email)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def make_floor(db_session, org_id, suffix="A"):
    hospital = Hospital(organization_id=org_id, name=f"Hospital {suffix}")
    db_session.add(hospital)
    db_session.flush()
    building = Building(
        organization_id=org_id, hospital_id=hospital.id, name=f"Building {suffix}"
    )
    db_session.add(building)
    db_session.flush()
    floor = Floor(
        organization_id=org_id, building_id=building.id, floor_number=0,
        name=f"Floor {suffix}",
    )
    db_session.add(floor)
    db_session.flush()
    return hospital.id, building.id, floor.id


def audit_actions(db_session, org_id):
    return db_session.scalars(
        select(AuditLog.action)
        .where(AuditLog.organization_id == org_id)
        .order_by(AuditLog.id)
    ).all()


def assert_error(response, status_code, code):
    assert response.status_code == status_code, response.text
    body = response.json()
    assert set(body) == {"error"}, body
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]


# --- #3 One JSON error format ------------------------------------------------

def test_http_errors_use_the_standard_error_format(client):
    assert_error(client.get("/api/v1/auth/me"), 401, "UNAUTHORIZED")
    assert_error(client.get("/api/v1/does-not-exist"), 404, "NOT_FOUND")
    assert_error(
        login(client, "no-such-org", "a@b.com", "Wrong!Password1"),
        401,
        "UNAUTHORIZED",
    )


def test_validation_errors_list_fields_without_echoing_input(client):
    secret_value = "short-secret-value"
    response = client.post(
        "/api/v1/auth/register-organization",
        json={
            "organization_name": "X",
            "full_name": "Valid Name",
            "email": "not-an-email",
            "password": secret_value,
        },
    )
    assert_error(response, 422, "VALIDATION_ERROR")
    fields = {item["field"] for item in response.json()["error"]["details"]}
    assert {"body.organization_name", "body.email", "body.password"} <= fields
    assert secret_value not in response.text


# --- #2 Role names follow the API contract ------------------------------------

def test_role_names_match_the_api_contract(client, db_session):
    org = register(client, "Contract Org")
    me = client.get("/api/v1/auth/me", headers=org["headers"])
    assert me.json()["role"] == "Administrator"

    commander = add_member(
        client, db_session, org, UserRole.EMERGENCY_COMMANDER, "cmd@example.com"
    )
    staff = add_member(client, db_session, org, UserRole.STAFF_USER, "staff@example.com")
    assert client.get("/api/v1/auth/me", headers=commander).json()["role"] == "Emergency Commander"
    assert client.get("/api/v1/auth/me", headers=staff).json()["role"] == "Staff User"

    response = login(client, org["slug"], "admin@example.com")
    user = response.json()["user"]
    assert {"id", "email", "full_name", "role"} <= set(user)
    assert user["role"] == "Administrator"


# --- #1 / #24 Role-based permissions ------------------------------------------

def test_staff_user_is_read_only(client, db_session):
    org = register(client, "Readonly Org")
    hospital_id, building_id, floor_id = make_floor(db_session, org["org_id"])
    admin = org["headers"]
    node_a = client.post(
        "/api/v1/nodes", headers=admin,
        json={"floor_id": floor_id, "name": "A", "type": "corridor"},
    ).json()
    node_b = client.post(
        "/api/v1/nodes", headers=admin,
        json={"floor_id": floor_id, "name": "B", "type": "exit"},
    ).json()
    edge = client.post(
        "/api/v1/edges", headers=admin,
        json={"from_node_id": node_a["id"], "to_node_id": node_b["id"],
              "distance": 5, "width": 2, "max_flow": 5},
    ).json()

    staff = add_member(client, db_session, org, UserRole.STAFF_USER, "staff@example.com")
    json_headers = {**staff, "Content-Type": "application/json"}

    forbidden = [
        client.post("/api/v1/hospitals", headers=staff, json={"timezone": "UTC", "name": "New"}),
        client.post("/api/v1/buildings",
                    headers=staff, json={"hospital_id": hospital_id, "name": "New"}),
        client.post("/api/v1/floors",
                    headers=staff, json={"building_id": building_id, "floor_number": 5, "name": "New"}),
        client.post("/api/v1/nodes", headers=staff,
                    json={"floor_id": floor_id, "name": "C", "type": "room"}),
        client.patch(f"/api/v1/nodes/{node_a['id']}", headers=staff,
                     json={"is_blocked": True}),
        client.post("/api/v1/edges", headers=staff,
                    json={"from_node_id": node_b["id"], "to_node_id": node_a["id"],
                          "distance": 1, "width": 1, "max_flow": 1}),
        client.patch(f"/api/v1/edges/{edge['id']}", headers=staff,
                     json={"is_blocked": True}),
        client.post(f"/api/v1/floors/{floor_id}/import", headers=json_headers,
                    content=b'{"nodes":[{"name":"Z","type":"room"}],"edges":[]}'),
        client.get(f"/api/v1/floors/{floor_id}/export", headers=staff),
    ]
    for response in forbidden:
        assert_error(response, 403, "FORBIDDEN")

    # Nothing changed.
    graph = client.get(f"/api/v1/floors/{floor_id}/graph", headers=staff)
    assert graph.status_code == 200
    assert {n["name"] for n in graph.json()["nodes"]} == {"A", "B"}
    assert all(not n["is_blocked"] for n in graph.json()["nodes"])

    # Read access still works.
    assert client.get("/api/v1/hospitals", headers=staff).status_code == 200
    route = client.post(f"/api/v1/floors/{floor_id}/route", headers=staff,
                        json={"start": "A"})
    assert route.status_code == 200, route.text


def test_emergency_commander_can_manage_facilities_and_graph(client, db_session):
    org = register(client, "Commander Org")
    commander = add_member(
        client, db_session, org, UserRole.EMERGENCY_COMMANDER, "cmd@example.com"
    )
    hospital = client.post("/api/v1/hospitals", headers=commander,
                           json={"timezone": "UTC", "name": "Commander Hospital"})
    assert hospital.status_code == 201, hospital.text
    building = client.post(
        "/api/v1/buildings",
        headers=commander, json={"hospital_id": hospital.json()['id'], "name": "Main"},
    )
    assert building.status_code == 201, building.text
    floor = client.post(
        "/api/v1/floors",
        headers=commander, json={"building_id": building.json()['id'], "floor_number": 0, "name": "Ground"},
    )
    assert floor.status_code == 201, floor.text
    node = client.post("/api/v1/nodes",
                       headers=commander, json={"floor_id": floor.json()['id'], "name": "Exit 1", "type": "exit"})
    assert node.status_code == 201, node.text


def test_facilities_are_isolated_between_organizations(client, db_session):
    first = register(client, "Facility Alpha")
    second = register(client, "Facility Beta")
    hospital_id, building_id, _ = make_floor(db_session, first["org_id"])

    other = second["headers"]
    # Phase 2 moved these to the contract paths (/hospitals, /buildings,
    # /floors). Lists filtered by another organization's ID return nothing,
    # direct access to its IDs is 404, and using its IDs in a request body is
    # a 422 validation error. Nothing is read or written in either case.
    assert client.get("/api/v1/hospitals", headers=other).json()["items"] == []
    for path in (
        f"/api/v1/buildings?hospital_id={hospital_id}",
        f"/api/v1/floors?building_id={building_id}",
    ):
        listed = client.get(path, headers=other)
        assert listed.status_code == 200 and listed.json()["items"] == [], listed.text
    for response in [
        client.get(f"/api/v1/hospitals/{hospital_id}", headers=other),
        client.get(f"/api/v1/buildings/{building_id}", headers=other),
        client.patch(f"/api/v1/hospitals/{hospital_id}", headers=other, json={"name": "Hacked"}),
        client.delete(f"/api/v1/buildings/{building_id}", headers=other),
    ]:
        assert_error(response, 404, "NOT_FOUND")
    for response in [
        client.post("/api/v1/buildings", headers=other,
                    json={"hospital_id": hospital_id, "name": "Intruder"}),
        client.post("/api/v1/floors", headers=other,
                    json={"building_id": building_id, "floor_number": 9, "name": "X"}),
    ]:
        assert_error(response, 422, "VALIDATION_ERROR")
    assert client.get(f"/api/v1/hospitals/{hospital_id}", headers=first["headers"]).json()["name"] == "Hospital A"


# --- #6 Unique email per organization ------------------------------------------

def _user(org_id, email):
    return User(organization_id=org_id, email=email, password_hash="x",
                full_name="Someone", role=UserRole.STAFF_USER, is_active=True)


def test_email_is_unique_per_organization_case_insensitive(client, db_session):
    org = register(client, "Unique Email Org", email="admin@example.com")
    db_session.add(_user(org["org_id"], "ADMIN@example.com"))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_same_email_allowed_in_other_org_and_after_soft_delete(client, db_session):
    first = register(client, "Email Org One", email="shared@example.com")
    register(client, "Email Org Two", email="shared@example.com")

    existing = db_session.get(User, first["user_id"])
    existing.deleted_at = db_session.scalar(select(func.now()))
    db_session.flush()
    db_session.add(_user(first["org_id"], "shared@example.com"))
    db_session.flush()  # must not raise


# --- #11 Audit log ---------------------------------------------------------------

def test_failed_logins_are_audited_without_secrets(client, db_session):
    org = register(client, "Audit Login Org")
    wrong = "Wrong!Password99"
    assert login(client, org["slug"], "admin@example.com", wrong).status_code == 401
    assert login(client, org["slug"], "ghost@example.com", wrong).status_code == 401

    rows = db_session.scalars(
        select(AuditLog).where(
            AuditLog.organization_id == org["org_id"],
            AuditLog.action == "auth.login_failed",
        ).order_by(AuditLog.id)
    ).all()
    assert len(rows) == 2
    assert rows[0].actor_user_id == org["user_id"]
    assert rows[1].actor_user_id is None
    assert all(row.details == {"reason": "invalid_credentials"} for row in rows)
    assert all(wrong not in str(row.details) for row in rows)


def test_creates_updates_and_imports_are_audited(client, db_session):
    org = register(client, "Audit Change Org")
    headers = org["headers"]
    hospital = client.post("/api/v1/hospitals", headers=headers,
                           json={"timezone": "UTC", "name": "Audited"}).json()
    building = client.post("/api/v1/buildings",
                           headers=headers, json={"hospital_id": hospital['id'], "name": "B"}).json()
    floor = client.post("/api/v1/floors",
                        headers=headers, json={"building_id": building['id'], "floor_number": 1, "name": "F"}).json()
    a = client.post("/api/v1/nodes", headers=headers,
                    json={"floor_id": floor['id'], "name": "A", "type": "room"}).json()
    b = client.post("/api/v1/nodes", headers=headers,
                    json={"floor_id": floor['id'], "name": "B", "type": "exit"}).json()
    client.patch(f"/api/v1/nodes/{a['id']}", headers=headers, json={"capacity": 4})
    edge = client.post("/api/v1/edges", headers=headers,
                       json={"from_node_id": a["id"], "to_node_id": b["id"],
                             "distance": 3, "width": 1, "max_flow": 2}).json()
    client.patch(f"/api/v1/edges/{edge['id']}", headers=headers, json={"distance": 4})
    imported = client.post(
        f"/api/v1/floors/{floor['id']}/import",
        headers={**headers, "Content-Type": "application/json"},
        content=b'{"nodes":[{"name":"C","type":"corridor"}],"edges":[]}',
    )
    assert imported.status_code == 201, imported.text

    assert audit_actions(db_session, org["org_id"]) == [
        "organization.registered",
        "hospital.created",
        "building.created",
        "floor.created",
        "node.created",
        "node.created",
        "node.updated",
        "edge.created",
        "edge.updated",
        "floor.imported",
    ]
    update = db_session.scalar(select(AuditLog).where(
        AuditLog.organization_id == org["org_id"], AuditLog.action == "node.updated"))
    assert update.details == {"fields": ["capacity"]}
    assert update.actor_user_id == org["user_id"]


def test_rejected_changes_are_not_audited(client, db_session):
    org = register(client, "Audit Reject Org")
    _, _, floor_id = make_floor(db_session, org["org_id"])
    staff = add_member(client, db_session, org, UserRole.STAFF_USER, "s@example.com")
    client.post("/api/v1/nodes", headers=staff,
                json={"floor_id": floor_id, "name": "X", "type": "room"})
    first = client.post("/api/v1/nodes", headers=org["headers"],
                        json={"floor_id": floor_id, "name": "Dup", "type": "room"})
    assert first.status_code == 201
    duplicate = client.post("/api/v1/nodes",
                            headers=org["headers"], json={"floor_id": floor_id, "name": "Dup", "type": "room"})
    assert_error(duplicate, 409, "CONFLICT")
    assert audit_actions(db_session, org["org_id"]).count("node.created") == 1


# --- #11 Rate limiting -----------------------------------------------------------

def test_account_is_locked_after_repeated_failures(client, db_session):
    org = register(client, "Lockout Org")
    limit = get_settings().login_max_failures_per_account
    for _ in range(limit):
        assert login(client, org["slug"], "admin@example.com", "Wrong!Password1").status_code == 401

    blocked = login(client, org["slug"], "admin@example.com")  # correct password
    assert_error(blocked, 429, "RATE_LIMITED")
    assert int(blocked.headers["Retry-After"]) > 0

    # Another account in the same organization is not affected
    # (add_member signs in through the API and asserts HTTP 200).
    add_member(client, db_session, org, UserRole.STAFF_USER, "other@example.com")


def test_successful_logins_do_not_count_toward_account_lockout(client):
    org = register(client, "No Lockout Org")
    limit = get_settings().login_max_failures_per_account
    for _ in range(limit + 2):
        assert login(client, org["slug"], "admin@example.com").status_code == 200


def test_login_attempts_are_limited_per_ip(client, monkeypatch):
    org = register(client, "Ip Limit Org")
    monkeypatch.setattr(get_settings(), "login_max_attempts_per_ip", 3)
    for _ in range(3):
        assert login(client, org["slug"], "admin@example.com").status_code == 200
    assert_error(login(client, org["slug"], "admin@example.com"), 429, "RATE_LIMITED")


def test_registration_is_limited_per_ip(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "register_max_attempts_per_ip", 2)
    register(client, "Reg One")
    register(client, "Reg Two")
    response = client.post(
        "/api/v1/auth/register-organization",
        json={"organization_name": "Reg Three", "full_name": "Test Admin",
              "email": "x@example.com", "password": PASSWORD},
    )
    assert_error(response, 429, "RATE_LIMITED")


# --- #17 / #18 Settings -----------------------------------------------------------

def test_env_file_path_is_absolute_project_root():
    env_file = Settings.model_config["env_file"]
    assert env_file == PROJECT_ROOT / ".env"
    assert (PROJECT_ROOT / "backend" / "app" / "config.py").exists()


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("http://a.example, http://b.example/", ["http://a.example", "http://b.example"]),
        ('["http://c.example"]', ["http://c.example"]),
    ],
)
def test_cors_origins_accept_comma_or_json_list(monkeypatch, raw, expected):
    monkeypatch.setenv("CORS_ORIGINS", raw)
    assert Settings().cors_origins == expected


def test_cors_wildcard_is_rejected(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "*")
    with pytest.raises(ValueError):
        Settings()
