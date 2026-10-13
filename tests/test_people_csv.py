"""Patients and staff as CSV: export, check (?apply=false) and import (?apply=true).

The file is the full list: new codes are added, changed rows updated, missing
codes removed. Nothing is saved when any row has a problem.
"""

import pytest
from app.db_session import get_db
from app.main import app
from app.models import AuditLog
from app.models.operations import Patient
from fastapi.testclient import TestClient
from sqlalchemy import select

API = "/api/v1"
PASSWORD = "StrongPassword!234"
CSV = {"Content-Type": "text/csv"}
PATIENT_HEADER = "patient_code,mobility,criticality,test_data,hospital,building,floor_number,place\r\n"
STAFF_HEADER = "staff_code,full_name,role,test_data,hospital,building,floor_number,place\r\n"


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


def register(client, name="CSV Org", email="admin@example.com"):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": name, "full_name": "Admin", "email": email, "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["organization"]["slug"]


def ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def site(client, h, hospital="Noble Hospital"):
    """Hospital > Main Block > floors 0 and 1, with Ward A on both and OPD on 0."""
    hosp = ok(client.post(f"{API}/hospitals", headers=h, json={"name": hospital, "timezone": "Asia/Kolkata"}), 201)
    block = ok(client.post(f"{API}/buildings", headers=h, json={"hospital_id": hosp["id"], "name": "Main Block"}), 201)
    places = {}
    for number in (0, 1):
        floor = ok(client.post(f"{API}/floors", headers=h, json={
            "building_id": block["id"], "floor_number": number, "name": f"Floor {number}"}), 201)
        for name in (("Ward A", "OPD") if number == 0 else ("Ward A",)):
            node = ok(client.post(f"{API}/nodes", headers=h, json={
                "floor_id": floor["id"], "name": name, "type": "ward"}), 201)
            places[(number, name)] = node["id"]
    return places


def send(client, h, kind, text, apply=False):
    return client.post(f"{API}/{kind}/import", headers={**h, **CSV}, params={"apply": str(apply).lower()},
                       content=text.encode("utf-8"))


def patients(client, h):
    items = ok(client.get(f"{API}/patients", headers=h, params={"limit": 200}))["items"]
    return {p["patient_code"]: p for p in items}


def test_check_then_apply_adds_updates_and_removes(client, db_session):
    h, _ = register(client)
    places = site(client, h)
    for code in ("KEEP", "CHANGE", "GONE"):
        ok(client.post(f"{API}/patients", headers=h, json={"patient_code": code, "mobility": "ambulatory"}), 201)

    text = (PATIENT_HEADER
            + "KEEP,ambulatory,3,false,,,,\r\n"
            + "CHANGE,Wheelchair,4,yes,Noble Hospital,Main Block,1,Ward A\r\n"
            + "NEW-1,stretcher,,TRUE,Noble Hospital,Main Block,0,OPD\r\n"
            + ",,,,,,,\r\n")                                    # an empty line from a spreadsheet
    expected = {"rows": 3, "added": 1, "updated": 1, "removed": 1, "unchanged": 1}

    checked = ok(send(client, h, "patients", text))
    assert checked == {"applied": False, **expected}
    assert set(patients(client, h)) == {"KEEP", "CHANGE", "GONE"}          # checking saves nothing

    applied = ok(send(client, h, "patients", text, apply=True))
    assert applied == {"applied": True, **expected}
    now = patients(client, h)
    assert set(now) == {"KEEP", "CHANGE", "NEW-1"}
    assert (now["CHANGE"]["mobility"], now["CHANGE"]["criticality"], now["CHANGE"]["is_synthetic"],
            now["CHANGE"]["node_id"]) == ("wheelchair", 4, True, places[(1, "Ward A")])
    assert (now["NEW-1"]["criticality"], now["NEW-1"]["node_id"]) == (3, places[(0, "OPD")])
    gone = db_session.scalar(select(Patient).where(Patient.patient_code == "GONE"))
    assert gone.deleted_at is not None                                    # soft delete, like the Delete button

    audit = db_session.scalars(select(AuditLog).where(AuditLog.action == "patient.imported")).all()
    assert len(audit) == 1 and audit[0].details == {"added": 1, "updated": 1, "removed": 1, "unchanged": 1}

    again = ok(send(client, h, "patients", text, apply=True))             # same file: nothing to do
    assert (again["added"], again["updated"], again["removed"], again["unchanged"]) == (0, 0, 0, 3)


def test_export_then_import_is_unchanged_and_keeps_formulas_harmless(client):
    h, _ = register(client)
    places = site(client, h)
    ok(client.post(f"{API}/patients", headers=h, json={
        "patient_code": "=HYPERLINK(1)", "mobility": "ventilator", "criticality": 5,
        "node_id": places[(1, "Ward A")], "is_synthetic": True}), 201)
    ok(client.post(f"{API}/patients", headers=h, json={"patient_code": "A1", "mobility": "ambulatory"}), 201)
    ok(client.post(f"{API}/staff", headers=h, json={
        "staff_code": "S1", "full_name": "Asha Rao", "role": "nurse", "node_id": places[(0, "OPD")]}), 201)

    exported = client.get(f"{API}/patients/export", headers=h)
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/csv")
    assert 'filename="patients.csv"' in exported.headers["content-disposition"]
    lines = exported.text.splitlines()
    assert lines[0] == PATIENT_HEADER.strip()
    assert lines[1] == "'=HYPERLINK(1),ventilator,5,true,Noble Hospital,Main Block,1,Ward A"   # sorted by code
    assert lines[2] == "A1,ambulatory,3,false,,,,"

    back = ok(send(client, h, "patients", exported.text, apply=True))
    assert (back["added"], back["updated"], back["removed"], back["unchanged"]) == (0, 0, 0, 2)
    assert "=HYPERLINK(1)" in patients(client, h)                          # the code is unchanged

    staff_file = client.get(f"{API}/staff/export", headers=h)
    assert staff_file.text.splitlines() == [STAFF_HEADER.strip(), "S1,Asha Rao,nurse,false,Noble Hospital,Main Block,0,OPD"]
    assert ok(send(client, h, "staff", staff_file.text))["unchanged"] == 1


def test_staff_import(client):
    h, _ = register(client)
    places = site(client, h)
    text = STAFF_HEADER + "N-1,Ward Nurse 1,nurse,true,Noble Hospital,Main Block,1,Ward A\r\nD-1,Dr Rao,doctor,,,,,\r\n"
    assert ok(send(client, h, "staff", text, apply=True))["added"] == 2
    staff = {s["staff_code"]: s for s in ok(client.get(f"{API}/staff", headers=h, params={"limit": 200}))["items"]}
    assert (staff["N-1"]["full_name"], staff["N-1"]["node_id"], staff["N-1"]["is_synthetic"]) == (
        "Ward Nurse 1", places[(1, "Ward A")], True)
    assert staff["D-1"]["node_id"] is None


def problems(response):
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["message"] == "The file has problems; nothing was saved"
    return {d["field"]: d["message"] for d in error["details"]}


def test_every_problem_is_reported_by_row_and_nothing_is_saved(client):
    h, _ = register(client)
    site(client, h)
    ok(client.post(f"{API}/patients", headers=h, json={"patient_code": "OLD", "mobility": "ambulatory"}), 201)
    text = (PATIENT_HEADER
            + "GOOD,ambulatory,3,false,,,,\r\n"                                # row 2: fine
            + "BAD-MOB,flying,3,false,,,,\r\n"                                 # row 3
            + "BAD-CRIT,ambulatory,9,false,,,,\r\n"                            # row 4
            + "HALF,ambulatory,3,false,Noble Hospital,,,\r\n"                  # row 5: partial place
            + "NOWHERE,ambulatory,3,false,Noble Hospital,Main Block,0,Kitchen\r\n"  # row 6
            + "GOOD,ambulatory,3,false,,,,\r\n"                                # row 7: same code as row 2
            + "BOOL,ambulatory,3,maybe,,,,\r\n"                                # row 8
            + ",ambulatory,3,false,,,,\r\n"                                    # row 9: no code
            + "SHORT,ambulatory\r\n")                                         # row 10
    found = problems(send(client, h, "patients", text, apply=True))
    assert set(found) == {"row 3, mobility", "row 4, criticality", "row 5, place", "row 6, place",
                          "row 7, patient_code", "row 8, test_data", "row 9, patient_code", "row 10"}
    assert found["row 7, patient_code"] == "The same code is already in row 2"
    assert "Kitchen" not in str(found) and "flying" not in str(found)     # values are never echoed
    assert set(patients(client, h)) == {"OLD"}                             # all or nothing


@pytest.mark.parametrize("text, message", [
    ("patient_code,mobility\r\nA,ambulatory\r\n", "Missing columns: criticality, test_data, hospital, building, floor_number, place"),
    (PATIENT_HEADER.strip() + ",notes\r\nA,ambulatory,3,false,,,,,x\r\n", "1 column name(s) are not expected"),
    (PATIENT_HEADER, "The file has no people. To remove everyone, delete them on the website"),
    ("", "The file has no header row"),
])
def test_file_level_problems(client, text, message):
    h, _ = register(client)
    found = problems(send(client, h, "patients", text, apply=True))
    assert any(m.startswith(message) for m in found.values()), found


def test_file_checks_type_size_and_encoding(client):
    h, _ = register(client)
    wrong_type = client.post(f"{API}/patients/import", headers={**h, "Content-Type": "application/json"}, content=b"{}")
    assert wrong_type.status_code == 415
    big = PATIENT_HEADER + "A,ambulatory,3,false,,,,\r\n" * 60_000
    assert len(big) > 1024 * 1024
    assert send(client, h, "patients", big).status_code == 413
    latin = client.post(f"{API}/patients/import", headers={**h, **CSV},
                        content=(PATIENT_HEADER + "Caf\xe9,ambulatory,3,false,,,,\r\n").encode("latin-1"))
    assert problems(latin) == {"file": "Save the file as CSV UTF-8"}
    many = PATIENT_HEADER + "".join(f"P{i},ambulatory,3,false,,,,\r\n" for i in range(5_001))
    assert problems(send(client, h, "patients", many)) == {"file": "At most 5,000 people per file"}


def test_staff_users_may_export_but_not_import(client):
    h, slug = register(client)
    ok(client.post(f"{API}/users", headers=h, json={
        "email": "staff@example.com", "full_name": "Staff", "password": PASSWORD, "role": "Staff User"}), 201)
    login = ok(client.post(f"{API}/auth/login", json={
        "organization_slug": slug, "email": "staff@example.com", "password": PASSWORD}))
    staff = {"Authorization": f"Bearer {login['access_token']}"}
    assert client.get(f"{API}/patients/export", headers=staff).status_code == 200
    assert send(client, staff, "patients", PATIENT_HEADER + "A,ambulatory,3,false,,,,\r\n").status_code == 403
    assert send(client, staff, "staff", STAFF_HEADER + "S,N,nurse,false,,,,\r\n").status_code == 403
    assert client.get(f"{API}/patients/export").status_code == 401


def test_organizations_never_see_or_use_each_others_people_or_places(client):
    h_a, _ = register(client, "Org A", "a@example.com")
    h_b, _ = register(client, "Org B", "b@example.com")
    site(client, h_b, hospital="B Hospital")
    ok(client.post(f"{API}/patients", headers=h_b, json={"patient_code": "B-ONLY", "mobility": "ambulatory"}), 201)

    assert client.get(f"{API}/patients/export", headers=h_a).text == PATIENT_HEADER
    # Org B's place names do not exist for org A.
    found = problems(send(client, h_a, "patients",
                          PATIENT_HEADER + "X,ambulatory,3,false,B Hospital,Main Block,0,OPD\r\n"))
    assert set(found) == {"row 2, place"}
    # Org A's full-list import never removes org B's people.
    ok(send(client, h_a, "patients", PATIENT_HEADER + "A-1,ambulatory,3,false,,,,\r\n", apply=True))
    assert set(patients(client, h_b)) == {"B-ONLY"}


def test_single_patient_routes_still_work_next_to_export(client):
    h, _ = register(client)
    made = ok(client.post(f"{API}/patients", headers=h, json={"patient_code": "P1", "mobility": "ambulatory"}), 201)
    assert ok(client.get(f"{API}/patients/{made['id']}", headers=h))["patient_code"] == "P1"
    assert client.get(f"{API}/patients/export", headers=h).status_code == 200
