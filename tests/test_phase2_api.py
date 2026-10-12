"""Phase 2 API tests: contract CRUD endpoints, rules and input safety.

Every resource goes through the same lifecycle test (create, read, list,
paginate, search, update, soft delete, audit), the same tenant-isolation test
and the same role test. Specific rules and defect fixes have their own tests.
"""

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import _password_hash
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, Edge, Hazard, User, UserRole

PASSWORD = "StrongPassword!234"
API = "/api/v1"


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


class Org:
    def __init__(self, client, db_session, name):
        self.client = client
        self.db = db_session
        response = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Org Admin",
            "email": "admin@example.com", "password": PASSWORD,
        })
        assert response.status_code == 201, response.text
        body = response.json()
        self.id = body["organization"]["id"]
        self.slug = body["organization"]["slug"]
        self.admin_id = body["user"]["id"]
        self.admin = {"Authorization": f"Bearer {body['access_token']}"}

    def member(self, role, email):
        self.db.add(User(
            organization_id=self.id, email=email, password_hash=_password_hash(PASSWORD),
            full_name=f"{role.value} user", role=role, is_active=True,
        ))
        self.db.flush()
        response = self.client.post(f"{API}/auth/login", json={
            "organization_slug": self.slug, "email": email, "password": PASSWORD,
        })
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def post(self, path, payload, headers=None):
        response = self.client.post(f"{API}{path}", headers=headers or self.admin, json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    def floor(self, suffix="A", floor_number=0, building_id=None):
        if building_id is None:
            hospital = self.post("/hospitals", {"name": f"Hospital {suffix}", "timezone": "Asia/Kolkata"})
            building_id = self.post("/buildings", {"hospital_id": hospital["id"], "name": f"Building {suffix}"})["id"]
        return self.post("/floors", {"building_id": building_id, "floor_number": floor_number,
                                     "name": f"Floor {suffix}{floor_number}"})

    def node(self, floor_id, name, type_="corridor"):
        return self.post("/nodes", {"floor_id": floor_id, "name": name, "type": type_})

    def edge(self, a, b, **extra):
        return self.post("/edges", {"from_node_id": a, "to_node_id": b, "distance": 5,
                                    "width": 2, "max_flow": 10, **extra})


def assert_error(response, status_code, code):
    assert response.status_code == status_code, response.text
    assert response.json()["error"]["code"] == code, response.text


def audit_actions(db_session, org_id, entity_type):
    return db_session.scalars(
        select(AuditLog.action).where(
            AuditLog.organization_id == org_id, AuditLog.entity_type == entity_type,
        ).order_by(AuditLog.id)
    ).all()


# --- Resource definitions for the shared tests ------------------------------------
# name -> (path, entity_type, make_payload(org, n), update_payload, search_field)

def _hospital(org, n):
    return {"name": f"Searchable Hospital {n}", "timezone": "Europe/London"}


def _building(org, n):
    hospital = org.post("/hospitals", {"name": f"Parent {n}", "timezone": "UTC"})
    return {"hospital_id": hospital["id"], "name": f"Searchable Building {n}"}


def _floor(org, n):
    hospital = org.post("/hospitals", {"name": f"FParent {n}", "timezone": "UTC"})
    building = org.post("/buildings", {"hospital_id": hospital["id"], "name": "B"})
    return {"building_id": building["id"], "floor_number": n, "name": f"Searchable Floor {n}"}


def _node(org, n):
    floor = org.floor(suffix=f"N{n}")
    return {"floor_id": floor["id"], "name": f"Searchable Node {n}", "type": "ward"}


def _patient(org, n):
    return {"patient_code": f"SEARCHABLE-{n}", "mobility": "wheelchair", "criticality": 4,
            "is_synthetic": True}


def _staff(org, n):
    return {"staff_code": f"S-{n}", "full_name": f"Searchable Nurse {n}", "role": "nurse"}


def _parameter(org, n):
    return {"name": f"searchable_speed_{n}", "value": "1.2", "unit": "m/s",
            "source": "assumed, to be validated"}


def _scenario(org, n):
    return {"name": f"Searchable Scenario {n}", "description": "Drill", "hazards": []}


def _user(org, n):
    return {"email": f"searchable{n}@example.com", "full_name": f"Searchable User {n}",
            "role": "Staff User", "password": PASSWORD}


RESOURCES = {
    "hospitals": ("/hospitals", "hospital", _hospital, {"address": "1 Main Road"}, "name"),
    "buildings": ("/buildings", "building", _building, {"description": "East wing"}, "name"),
    "floors": ("/floors", "floor", _floor, {"elevation_metres": 3.5}, "name"),
    "nodes": ("/nodes", "node", _node, {"capacity": 12}, "name"),
    "patients": ("/patients", "patient", _patient, {"criticality": 5}, "patient_code"),
    "staff": ("/staff", "staff", _staff, {"role": "doctor"}, "full_name"),
    "parameters": ("/parameters", "parameter", _parameter, {"value": "1.4"}, "name"),
    "scenarios": ("/scenarios", "scenario", _scenario, {"description": "Night drill"}, "name"),
    "users": ("/users", "user", _user, {"full_name": "Renamed User"}, "full_name"),
}


@pytest.mark.parametrize("resource", RESOURCES)
def test_resource_lifecycle(client, db_session, resource):
    path, entity_type, make, update, search_field = RESOURCES[resource]
    org = Org(client, db_session, f"Lifecycle {resource}")

    created = [org.post(path, make(org, n)) for n in (1, 2, 3)]
    first = created[0]

    got = client.get(f"{API}{path}/{first['id']}", headers=org.admin)
    assert got.status_code == 200 and got.json()["id"] == first["id"]

    listing = client.get(f"{API}{path}", headers=org.admin, params={"q": "searchable"}).json()
    assert listing["total"] == 3 and len(listing["items"]) == 3

    page = client.get(f"{API}{path}", headers=org.admin,
                      params={"q": "searchable", "limit": 2, "offset": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 1
    assert (page["limit"], page["offset"]) == (2, 2)

    one = client.get(f"{API}{path}", headers=org.admin,
                     params={"q": first[search_field].upper()}).json()
    assert [item["id"] for item in one["items"]] == [first["id"]]

    patched = client.patch(f"{API}{path}/{first['id']}", headers=org.admin, json=update)
    assert patched.status_code == 200, patched.text
    for field, value in update.items():
        assert patched.json()[field] == value

    deleted = client.delete(f"{API}{path}/{first['id']}", headers=org.admin)
    assert deleted.status_code == 204, deleted.text
    assert_error(client.get(f"{API}{path}/{first['id']}", headers=org.admin), 404, "NOT_FOUND")
    remaining = client.get(f"{API}{path}", headers=org.admin, params={"q": "searchable"}).json()
    assert first["id"] not in {item["id"] for item in remaining["items"]}
    assert_error(client.delete(f"{API}{path}/{first['id']}", headers=org.admin), 404, "NOT_FOUND")

    actions = audit_actions(db_session, org.id, entity_type)
    assert actions.count(f"{entity_type}.created") == 3
    assert f"{entity_type}.updated" in actions and f"{entity_type}.deleted" in actions


@pytest.mark.parametrize("resource", RESOURCES)
def test_resource_is_isolated_between_organizations(client, db_session, resource):
    path, _, make, update, _ = RESOURCES[resource]
    owner = Org(client, db_session, f"Owner {resource}")
    intruder = Org(client, db_session, f"Intruder {resource}")
    item = owner.post(path, make(owner, 1))

    listing = client.get(f"{API}{path}", headers=intruder.admin).json()
    assert item["id"] not in {row["id"] for row in listing["items"]}
    for response in (
        client.get(f"{API}{path}/{item['id']}", headers=intruder.admin),
        client.patch(f"{API}{path}/{item['id']}", headers=intruder.admin, json=update),
        client.delete(f"{API}{path}/{item['id']}", headers=intruder.admin),
    ):
        assert_error(response, 404, "NOT_FOUND")
    assert client.get(f"{API}{path}/{item['id']}", headers=owner.admin).status_code == 200


@pytest.mark.parametrize("resource", RESOURCES)
def test_resource_role_permissions(client, db_session, resource):
    path, _, make, update, _ = RESOURCES[resource]
    org = Org(client, db_session, f"Roles {resource}")
    item = org.post(path, make(org, 1))
    staff = org.member(UserRole.STAFF_USER, "staff@example.com")
    commander = org.member(UserRole.EMERGENCY_COMMANDER, "commander@example.com")
    admin_only = resource == "users"

    # Staff User: read-only (and no access to user management).
    read = client.get(f"{API}{path}/{item['id']}", headers=staff)
    assert read.status_code == (403 if admin_only else 200), read.text
    for response in (
        client.post(f"{API}{path}", headers=staff, json=make(org, 2)),
        client.patch(f"{API}{path}/{item['id']}", headers=staff, json=update),
        client.delete(f"{API}{path}/{item['id']}", headers=staff),
    ):
        assert_error(response, 403, "FORBIDDEN")

    # Emergency Commander: everything except Admin (user management).
    patched = client.patch(f"{API}{path}/{item['id']}", headers=commander, json=update)
    assert patched.status_code == (403 if admin_only else 200), patched.text


def test_list_endpoints_require_authentication(client):
    for path in ("/hospitals", "/buildings", "/floors", "/nodes", "/edges", "/patients",
                 "/staff", "/parameters", "/scenarios", "/users", "/audit_log"):
        assert_error(client.get(f"{API}{path}"), 401, "UNAUTHORIZED")


def test_search_treats_wildcards_literally(client, db_session):
    org = Org(client, db_session, "Wildcards")
    org.post("/hospitals", {"name": "Plain", "timezone": "UTC"})
    org.post("/hospitals", {"name": "100% Care", "timezone": "UTC"})
    names = lambda q: [h["name"] for h in client.get(  # noqa: E731
        f"{API}/hospitals", headers=org.admin, params={"q": q}).json()["items"]]
    assert names("%") == ["100% Care"]
    assert names("_") == []


def test_pagination_bounds_are_validated(client, db_session):
    org = Org(client, db_session, "Paging Bounds")
    for params in ({"limit": 0}, {"limit": 201}, {"offset": -1}):
        assert_error(client.get(f"{API}/hospitals", headers=org.admin, params=params),
                     422, "VALIDATION_ERROR")


# --- #16 / #14 input validation ---------------------------------------------------------

@pytest.mark.parametrize("payload", [
    {"name": "   ", "timezone": "UTC"},
    {"name": "Valid", "timezone": "Not/AZone"},
    {"name": "Valid"},
    {"name": "Valid", "timezone": "UTC", "unexpected": 1},
])
def test_hospital_input_is_validated(client, db_session, payload):
    org = Org(client, db_session, "Validation Hospital")
    assert_error(client.post(f"{API}/hospitals", headers=org.admin, json=payload),
                 422, "VALIDATION_ERROR")


def test_names_are_trimmed(client, db_session):
    org = Org(client, db_session, "Trim Org")
    assert org.post("/hospitals", {"name": "  City Hospital  ", "timezone": "UTC"})["name"] == "City Hospital"


@pytest.mark.parametrize("raw", [
    b'{"floor_id": FLOOR, "name": "A", "type": "room", "x": NaN}',
    b'{"floor_id": FLOOR, "name": "A", "type": "room", "y": Infinity}',
    b'{"floor_id": FLOOR, "name": "A", "type": "room", "x": 1e999}',
])
def test_non_finite_coordinates_are_rejected(client, db_session, raw):
    org = Org(client, db_session, "Finite Org")
    floor = org.floor()
    body = raw.replace(b"FLOOR", str(floor["id"]).encode())
    response = client.post(f"{API}/nodes", headers={**org.admin, "Content-Type": "application/json"},
                           content=body)
    assert_error(response, 422, "VALIDATION_ERROR")


def test_non_finite_edge_distance_is_rejected(client, db_session):
    org = Org(client, db_session, "Finite Edge Org")
    floor = org.floor()
    a, b = org.node(floor["id"], "A"), org.node(floor["id"], "B", "exit")
    body = json.dumps({"from_node_id": a["id"], "to_node_id": b["id"], "width": 1,
                       "max_flow": 1}).replace("}", ', "distance": 1e999}').encode()
    response = client.post(f"{API}/edges", headers={**org.admin, "Content-Type": "application/json"},
                           content=body)
    assert_error(response, 422, "VALIDATION_ERROR")


def test_patch_rejects_empty_body_and_null_for_required_fields(client, db_session):
    org = Org(client, db_session, "Patch Rules")
    hospital = org.post("/hospitals", {"name": "H", "timezone": "UTC"})
    url = f"{API}/hospitals/{hospital['id']}"
    assert_error(client.patch(url, headers=org.admin, json={}), 422, "VALIDATION_ERROR")
    assert_error(client.patch(url, headers=org.admin, json={"name": None}), 422, "VALIDATION_ERROR")
    cleared = client.patch(url, headers=org.admin, json={"address": None})
    assert cleared.status_code == 200 and cleared.json()["address"] is None


# --- Delete rules -----------------------------------------------------------------------------

def test_parents_with_active_children_cannot_be_deleted(client, db_session):
    org = Org(client, db_session, "Delete Rules")
    floor = org.floor()
    building = client.get(f"{API}/buildings/{floor['building_id']}", headers=org.admin).json()
    org.node(floor["id"], "A")
    for path in (f"/hospitals/{building['hospital_id']}", f"/buildings/{building['id']}",
                 f"/floors/{floor['id']}"):
        assert_error(client.delete(f"{API}{path}", headers=org.admin), 409, "CONFLICT")


def test_deleting_a_node_removes_its_edges(client, db_session):
    org = Org(client, db_session, "Node Delete")
    floor = org.floor()
    a, b, c = (org.node(floor["id"], n) for n in "ABC")
    ab, bc = org.edge(a["id"], b["id"]), org.edge(b["id"], c["id"])
    assert client.delete(f"{API}/nodes/{b['id']}", headers=org.admin).status_code == 204
    for edge in (ab, bc):
        assert_error(client.get(f"{API}/edges/{edge['id']}", headers=org.admin), 404, "NOT_FOUND")
    assert client.get(f"{API}/floors/{floor['id']}/graph", headers=org.admin).json()["edges"] == []


def test_node_with_patients_cannot_be_deleted(client, db_session):
    org = Org(client, db_session, "Node With Patient")
    floor = org.floor()
    node = org.node(floor["id"], "Ward 1", "ward")
    org.post("/patients", {"patient_code": "P1", "mobility": "stretcher", "node_id": node["id"]})
    assert_error(client.delete(f"{API}/nodes/{node['id']}", headers=org.admin), 409, "CONFLICT")


# --- Edges: undirected, same building, vertical connectors --------------------------------

def test_reverse_duplicate_edge_is_a_conflict(client, db_session):
    org = Org(client, db_session, "Reverse Edge")
    floor = org.floor()
    a, b = org.node(floor["id"], "A"), org.node(floor["id"], "B")
    org.edge(a["id"], b["id"])
    response = client.post(f"{API}/edges", headers=org.admin, json={
        "from_node_id": b["id"], "to_node_id": a["id"], "distance": 500, "width": 1, "max_flow": 1})
    assert_error(response, 409, "CONFLICT")


def test_edges_between_floors_use_stairs_ramps_or_lifts(client, db_session):
    org = Org(client, db_session, "Multi Floor")
    ground = org.floor(floor_number=0)
    upper = org.floor(floor_number=1, building_id=ground["building_id"])
    stair_0 = org.node(ground["id"], "Stair G", "stair")
    stair_1 = org.node(upper["id"], "Stair 1", "stair")
    corridor_1 = org.node(upper["id"], "Corridor 1", "corridor")
    other_building = org.floor(suffix="Other")
    stair_other = org.node(other_building["id"], "Stair X", "stair")

    link = org.edge(stair_0["id"], stair_1["id"], distance=4)
    for start, end, message in (
        (stair_0, corridor_1, "stairs, ramps or lifts"),
        (stair_0, stair_other, "same building"),
    ):
        response = client.post(f"{API}/edges", headers=org.admin, json={
            "from_node_id": start["id"], "to_node_id": end["id"],
            "distance": 4, "width": 1, "max_flow": 1})
        assert_error(response, 422, "VALIDATION_ERROR")
        assert message in response.json()["error"]["message"]

    # The cross-floor edge is listed for both floors.
    for floor in (ground, upper):
        ids = [e["id"] for e in client.get(f"{API}/edges", headers=org.admin,
                                           params={"floor_id": floor["id"]}).json()["items"]]
        assert ids == [link["id"]]

    # A node that links floors cannot stop being a vertical connector.
    assert_error(client.patch(f"{API}/nodes/{stair_0['id']}", headers=org.admin,
                              json={"type": "corridor"}), 409, "CONFLICT")
    assert client.patch(f"{API}/nodes/{stair_0['id']}", headers=org.admin,
                        json={"type": "lift"}).status_code == 200


def test_body_references_must_belong_to_the_organization(client, db_session):
    owner = Org(client, db_session, "Ref Owner")
    other = Org(client, db_session, "Ref Other")
    foreign_floor = owner.floor()
    foreign_node = owner.node(foreign_floor["id"], "Foreign")
    own_floor = other.floor()
    own_node = other.node(own_floor["id"], "Own")
    for path, payload in (
        ("/nodes", {"floor_id": foreign_floor["id"], "name": "X", "type": "room"}),
        ("/edges", {"from_node_id": own_node["id"], "to_node_id": foreign_node["id"],
                    "distance": 1, "width": 1, "max_flow": 1}),
        ("/patients", {"patient_code": "P", "mobility": "ambulatory", "node_id": foreign_node["id"]}),
        ("/staff", {"staff_code": "S", "full_name": "N", "role": "nurse", "node_id": foreign_node["id"]}),
        ("/scenarios", {"name": "S", "hazards": [{"name": "Fire", "type": "fire",
                                                  "origin_node_id": foreign_node["id"]}]}),
    ):
        response = client.post(f"{API}{path}", headers=other.admin, json=payload)
        assert_error(response, 422, "VALIDATION_ERROR")


# --- Scenarios with hazards -------------------------------------------------------------

def test_scenario_hazards_are_created_replaced_and_deleted(client, db_session):
    org = Org(client, db_session, "Scenario Hazards")
    floor = org.floor()
    c1, icu = org.node(floor["id"], "C1"), org.node(floor["id"], "ICU", "icu")
    scenario = org.post("/scenarios", {"name": "Fire at C1", "hazards": [
        {"name": "Fire C1", "type": "fire", "origin_node_id": c1["id"], "spread_rate": 0.5, "severity": 4},
    ]})
    assert [(h["name"], h["severity"]) for h in scenario["hazards"]] == [("Fire C1", 4)]

    replaced = client.patch(f"{API}/scenarios/{scenario['id']}", headers=org.admin, json={
        "hazards": [{"name": "Smoke ICU", "type": "smoke", "origin_node_id": icu["id"]}]})
    assert replaced.status_code == 200, replaced.text
    assert [h["name"] for h in replaced.json()["hazards"]] == ["Smoke ICU"]

    renamed = client.patch(f"{API}/scenarios/{scenario['id']}", headers=org.admin,
                           json={"name": "Smoke at ICU"})
    assert [h["name"] for h in renamed.json()["hazards"]] == ["Smoke ICU"]

    assert client.delete(f"{API}/scenarios/{scenario['id']}", headers=org.admin).status_code == 204
    active = db_session.scalars(select(Hazard).where(
        Hazard.scenario_id == scenario["id"], Hazard.deleted_at.is_(None))).all()
    assert active == []


def test_scenario_hazard_limits(client, db_session):
    org = Org(client, db_session, "Hazard Limits")
    node = org.node(org.floor()["id"], "N")
    for hazard in ({"severity": 6}, {"spread_rate": -1}, {"type": "flood"}):
        payload = {"name": "S", "hazards": [{"name": "H", "type": "fire",
                                             "origin_node_id": node["id"], **hazard}]}
        assert_error(client.post(f"{API}/scenarios", headers=org.admin, json=payload),
                     422, "VALIDATION_ERROR")


# --- Users ----------------------------------------------------------------------------------

def test_admin_adds_a_user_who_can_sign_in(client, db_session):
    org = Org(client, db_session, "User Admin")
    created = org.post("/users", {"email": "  Nurse@Example.com ", "full_name": "Nurse",
                                  "role": "Emergency Commander", "password": PASSWORD})
    assert created["email"] == "nurse@example.com"
    assert created["role"] == "Emergency Commander"
    assert "password" not in created and "password_hash" not in created
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": org.slug, "email": "nurse@example.com", "password": PASSWORD})
    assert login.status_code == 200 and login.json()["user"]["role"] == "Emergency Commander"

    duplicate = client.post(f"{API}/users", headers=org.admin, json={
        "email": "NURSE@example.com", "full_name": "Again", "role": "Staff User", "password": PASSWORD})
    assert_error(duplicate, 409, "CONFLICT")


@pytest.mark.parametrize("payload", [
    {"email": "x@example.com", "full_name": "X", "role": "administrator", "password": PASSWORD},
    {"email": "x@example.com", "full_name": "X", "role": "Staff User", "password": "weakpassword1"},
    {"email": "not-an-email", "full_name": "X", "role": "Staff User", "password": PASSWORD},
])
def test_user_input_is_validated(client, db_session, payload):
    org = Org(client, db_session, "User Validation")
    assert_error(client.post(f"{API}/users", headers=org.admin, json=payload), 422, "VALIDATION_ERROR")


def test_last_administrator_is_protected(client, db_session):
    org = Org(client, db_session, "Last Admin")
    me = f"{API}/users/{org.admin_id}"
    assert_error(client.patch(me, headers=org.admin, json={"role": "Staff User"}), 409, "CONFLICT")
    assert_error(client.patch(me, headers=org.admin, json={"is_active": False}), 409, "CONFLICT")
    assert_error(client.delete(me, headers=org.admin), 409, "CONFLICT")

    # With a second administrator, the first may step down.
    org.post("/users", {"email": "second@example.com", "full_name": "Second Admin",
                        "role": "Administrator", "password": PASSWORD})
    stepped_down = client.patch(me, headers=org.admin, json={"role": "Staff User"})
    assert stepped_down.status_code == 200 and stepped_down.json()["role"] == "Staff User"
    # The token still belongs to that user, who is now a Staff User.
    assert_error(client.get(f"{API}/users", headers=org.admin), 403, "FORBIDDEN")


def test_deactivated_user_loses_access_immediately(client, db_session):
    org = Org(client, db_session, "Deactivate")
    org.post("/users", {"email": "leaver@example.com", "full_name": "Leaver",
                        "role": "Emergency Commander", "password": PASSWORD})
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": org.slug, "email": "leaver@example.com", "password": PASSWORD}).json()
    leaver = {"Authorization": f"Bearer {login['access_token']}"}
    assert client.get(f"{API}/hospitals", headers=leaver).status_code == 200

    client.patch(f"{API}/users/{login['user']['id']}", headers=org.admin, json={"is_active": False})
    assert_error(client.get(f"{API}/hospitals", headers=leaver), 401, "UNAUTHORIZED")
    refresh = client.post(f"{API}/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert_error(refresh, 401, "UNAUTHORIZED")


def test_password_reset_revokes_existing_sessions(client, db_session):
    org = Org(client, db_session, "Password Reset")
    user = org.post("/users", {"email": "r@example.com", "full_name": "R",
                               "role": "Staff User", "password": PASSWORD})
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": org.slug, "email": "r@example.com", "password": PASSWORD}).json()
    client.patch(f"{API}/users/{user['id']}", headers=org.admin,
                 json={"password": "AnotherStrong!Pass99"})
    # The account is still active, so only token revocation can stop this.
    refresh = client.post(f"{API}/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert_error(refresh, 401, "UNAUTHORIZED")


def test_password_change_is_audited_without_the_password(client, db_session):
    org = Org(client, db_session, "Password Audit")
    user = org.post("/users", {"email": "p@example.com", "full_name": "P",
                               "role": "Staff User", "password": PASSWORD})
    new_password = "AnotherStrong!Pass99"
    client.patch(f"{API}/users/{user['id']}", headers=org.admin, json={"password": new_password})
    row = db_session.scalar(select(AuditLog).where(
        AuditLog.organization_id == org.id, AuditLog.action == "user.updated"))
    assert row.details == {"fields": ["password"]}
    assert new_password not in json.dumps(row.details)


# --- Audit log endpoint -----------------------------------------------------------------------

def test_audit_log_is_admin_only_newest_first_and_isolated(client, db_session):
    org = Org(client, db_session, "Audit View")
    other = Org(client, db_session, "Audit Other")
    org.post("/hospitals", {"name": "First", "timezone": "UTC"})
    org.post("/hospitals", {"name": "Second", "timezone": "UTC"})
    commander = org.member(UserRole.EMERGENCY_COMMANDER, "c@example.com")

    log = client.get(f"{API}/audit_log", headers=org.admin, params={"entity_type": "hospital"}).json()
    assert [row["action"] for row in log["items"]] == ["hospital.created", "hospital.created"]
    assert log["items"][0]["id"] > log["items"][1]["id"]
    assert_error(client.get(f"{API}/audit_log", headers=commander), 403, "FORBIDDEN")

    theirs = client.get(f"{API}/audit_log", headers=other.admin, params={"entity_type": "hospital"}).json()
    assert theirs["items"] == []


# --- Floor import / export safety --------------------------------------------------------

def _import(client, org, floor_id, body, content_type):
    return client.post(f"{API}/floors/{floor_id}/import",
                       headers={**org.admin, "Content-Type": content_type}, content=body)


@pytest.mark.parametrize("body", [
    b'{"type":"FeatureCollection","features":[1]}',
    b'{"type":"FeatureCollection","features":"abc"}',
    b'{"type":"FeatureCollection","features":[{"properties":[],"geometry":{}}]}',
    b'{"type":"FeatureCollection","features":[{"properties":{"record_type":"node","name":"A",'
    b'"type":"room"},"geometry":{"type":"Point","coordinates":5}}]}',
])
def test_malformed_geojson_gives_422_not_500(client, db_session, body):
    org = Org(client, db_session, "Bad GeoJSON")
    floor = org.floor()
    assert_error(_import(client, org, floor["id"], body, "application/geo+json"), 422, "VALIDATION_ERROR")


@pytest.mark.parametrize("body", [
    b'{"nodes":[{"name":"A","type":"room","x":NaN}],"edges":[]}',
    b'{"nodes":[{"name":"   ","type":"room"}],"edges":[]}',
    b'{"nodes":[{"name":"A","type":"room"},{"name":"B","type":"exit"}],'
    b'"edges":[{"from_node":"A","to_node":"B","distance":1e999,"width":1,"max_flow":1}]}',
])
def test_import_rejects_invalid_values(client, db_session, body):
    org = Org(client, db_session, "Bad Values")
    floor = org.floor()
    assert_error(_import(client, org, floor["id"], body, "application/json"), 422, "VALIDATION_ERROR")


def test_import_rejects_reverse_duplicate_edges(client, db_session):
    org = Org(client, db_session, "Import Reverse")
    floor = org.floor()
    body = json.dumps({
        "nodes": [{"name": "A", "type": "room"}, {"name": "B", "type": "exit"}],
        "edges": [
            {"from_node": "A", "to_node": "B", "distance": 1, "width": 1, "max_flow": 1},
            {"from_node": "B", "to_node": "A", "distance": 9, "width": 1, "max_flow": 1},
        ],
    }).encode()
    assert_error(_import(client, org, floor["id"], body, "application/json"), 422, "VALIDATION_ERROR")


def test_import_rejects_edge_that_already_exists_in_reverse(client, db_session):
    org = Org(client, db_session, "Import Existing Reverse")
    floor = org.floor()
    a, b = org.node(floor["id"], "A"), org.node(floor["id"], "B")
    org.edge(a["id"], b["id"])
    body = json.dumps({"nodes": [], "edges": [
        {"from_node": "B", "to_node": "A", "distance": 1, "width": 1, "max_flow": 1}]}).encode()
    assert_error(_import(client, org, floor["id"], body, "application/json"), 409, "CONFLICT")


def test_import_size_caps(client, db_session):
    org = Org(client, db_session, "Import Caps")
    floor = org.floor()
    body = json.dumps({"nodes": [{"name": f"N{i}", "type": "room"} for i in range(5001)],
                       "edges": []}).encode()
    assert_error(_import(client, org, floor["id"], body, "application/json"), 422, "VALIDATION_ERROR")


def test_csv_export_neutralises_formulas_and_round_trips(client, db_session):
    org = Org(client, db_session, "Csv Safety")
    source, target = org.floor(suffix="S"), org.floor(suffix="T")
    dangerous = '=HYPERLINK("http://evil.example","x")'
    a = org.node(source["id"], dangerous, "room")
    b = org.node(source["id"], "-1+2", "exit")
    org.edge(a["id"], b["id"])

    exported = client.get(f"{API}/floors/{source['id']}/export", headers=org.admin,
                          params={"format": "csv"})
    rows = list(csv.DictReader(io.StringIO(exported.text)))
    cells = [value for row in rows for value in row.values() if value]
    assert not any(cell.startswith(("=", "+", "-", "@")) for cell in cells
                   if not cell.lstrip("-").replace(".", "", 1).isdigit())
    assert rows[0]["name"] == "'" + dangerous

    imported = _import(client, org, target["id"], exported.content, "text/csv")
    assert imported.status_code == 201, imported.text
    names = {n["name"] for n in client.get(f"{API}/floors/{target['id']}/graph",
                                           headers=org.admin).json()["nodes"]}
    assert names == {dangerous, "-1+2"}


def test_import_is_all_or_nothing(client, db_session):
    org = Org(client, db_session, "Atomic Import")
    floor = org.floor()
    org.node(floor["id"], "Existing")
    body = json.dumps({"nodes": [{"name": "New", "type": "room"}], "edges": [
        {"from_node": "New", "to_node": "Missing", "distance": 1, "width": 1, "max_flow": 1}]}).encode()
    assert_error(_import(client, org, floor["id"], body, "application/json"), 422, "VALIDATION_ERROR")
    names = [n["name"] for n in client.get(f"{API}/floors/{floor['id']}/graph",
                                           headers=org.admin).json()["nodes"]]
    assert names == ["Existing"]
    assert db_session.scalars(select(Edge).where(Edge.organization_id == org.id)).all() == []


# --- Route request ------------------------------------------------------------------------

def test_route_start_must_be_an_id_or_a_name(client, db_session):
    org = Org(client, db_session, "Route Input")
    floor = org.floor()
    for start in (True, "   ", 0):
        response = client.post(f"{API}/floors/{floor['id']}/route", headers=org.admin,
                               json={"start": start})
        assert_error(response, 422, "VALIDATION_ERROR")
