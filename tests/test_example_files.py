"""The made-up example files in docs/examples import as documented (README
section 11) and give a working hospital: floor plan, patients, staff, a run.
Loaded into health11_test inside the test's transaction (nothing kept)."""

from pathlib import Path

import pytest
from app.db_session import get_db
from app.main import app
from fastapi.testclient import TestClient

API = "/api/v1"
PASSWORD = "Example-Files-2026!"
EXAMPLES = Path(__file__).resolve().parents[1] / "docs" / "examples"


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


def call(client, method, path, headers, expect, **kwargs):
    response = client.request(method, f"{API}{path}", headers=headers, **kwargs)
    assert response.status_code == expect, response.text
    return response.json()


def test_the_example_files_make_a_working_hospital(client):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Riverside Import Demo", "full_name": "Admin",
        "email": "admin@example.com", "password": PASSWORD}).json()
    h = {"Authorization": f"Bearer {body['access_token']}"}

    # The hospital, building and floor the files name (Facility Manager).
    hospital = call(client, "POST", "/hospitals", h, 201,
                    json={"name": "Riverside Hospital (made-up)", "timezone": "Asia/Kolkata"})
    building = call(client, "POST", "/buildings", h, 201, json={"hospital_id": hospital["id"], "name": "Main Building"})
    floor = call(client, "POST", "/floors", h, 201,
                 json={"building_id": building["id"], "floor_number": 0, "name": "Ground"})

    # 1) The floor plan (Facility Manager, Import).
    plan = (EXAMPLES / "riverside-ground-floor.csv").read_bytes()
    result = call(client, "POST", f"/floors/{floor['id']}/import", {**h, "Content-Type": "text/csv"}, 201, content=plan)
    assert result == {"floor_id": floor["id"], "nodes_imported": 15, "edges_imported": 14}
    graph = call(client, "GET", f"/floors/{floor['id']}/graph", h, 200)
    assert all(n["width_m"] and n["length_m"] for n in graph["nodes"])

    # 2) and 3) Patients and staff (Patients & Staff, Import CSV): checked first, then saved.
    for kind, file, count in (("patients", "riverside-patients.csv", 20), ("staff", "riverside-staff.csv", 8)):
        data = (EXAMPLES / file).read_bytes()
        headers = {**h, "Content-Type": "text/csv"}
        check = call(client, "POST", f"/{kind}/import", headers, 200, content=data, params={"apply": "false"})
        assert (check["applied"], check["added"], check["removed"]) == (False, count, 0)
        saved = call(client, "POST", f"/{kind}/import", headers, 200, content=data, params={"apply": "true"})
        assert (saved["applied"], saved["added"]) == (True, count)
        listed = call(client, "GET", f"/{kind}", h, 200, params={"limit": 100})
        assert listed["total"] == count
        assert all(item["is_synthetic"] and item["node_id"] for item in listed["items"])

    # A fire in the Pharmacy: everyone gets out.
    pharmacy = next(n["id"] for n in graph["nodes"] if n["name"] == "Pharmacy")
    scenario = call(client, "POST", "/scenarios", h, 201, json={"name": "Fire in the Pharmacy", "hazards": [
        {"name": "Fire at Pharmacy", "type": "fire", "origin_node_id": pharmacy, "severity": 4, "spread_rate": 2}]})
    run_id = call(client, "POST", "/simulate", h, 201, json={"scenario_id": scenario["id"], "algorithm": "dijkstra"})["run_id"]
    run = call(client, "GET", f"/simulation_runs/{run_id}", h, 200)
    assert run["status"] == "completed" and run["summary"]["all_evacuated"] is True
    assert run["summary"]["total"] == 28
