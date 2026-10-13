"""Contract test: the exact requests the website sends (frontend/src), checked
against the real API. If the website and the API drift apart, this fails.

Covers the Facility Manager and the onboarding wizard (Phase 10, group 1).
"""

import pytest
from fastapi.testclient import TestClient

from app.db_session import get_db
from app.main import app

API = "/api/v1"
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


def admin(client):
    body = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Contract Org", "full_name": "Admin",
        "email": "admin@example.com", "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {body['access_token']}"}


def call(client, auth, method, path, expect, **kwargs):
    kwargs.setdefault("headers", auth)
    response = client.request(method, f"{API}{path}", **kwargs)
    assert response.status_code == expect, response.text
    return response


def test_facility_manager_requests(client):
    h = admin(client)
    # HospitalForm: optional address sent as null, time zone from the browser list.
    hospital = call(client, h, "POST", "/hospitals", 201,
                    json={"name": "General", "address": None, "timezone": "Asia/Kolkata"}).json()
    call(client, h, "PATCH", f"/hospitals/{hospital['id']}", 200,
         json={"name": "General", "address": "1 Main Road", "timezone": "Asia/Kolkata"})
    # BuildingForm and FloorForm (elevation optional -> null).
    building = call(client, h, "POST", "/buildings", 201,
                    json={"hospital_id": hospital["id"], "name": "Main", "description": None}).json()
    call(client, h, "PATCH", f"/buildings/{building['id']}", 200, json={"name": "Main", "description": "Old wing"})
    floor = call(client, h, "POST", "/floors", 201, json={
        "building_id": building["id"], "name": "Ground", "floor_number": 0, "elevation_metres": None}).json()
    call(client, h, "PATCH", f"/floors/{floor['id']}", 200,
         json={"name": "Ground", "floor_number": 0, "elevation_metres": 0.5})

    # The lists the page loads with apiAll (limit 200, offset 0) without filters.
    for path in ("/hospitals", "/buildings", "/floors"):
        page = call(client, h, "GET", path, 200, params={"limit": 200, "offset": 0}).json()
        assert page["total"] == 1 and len(page["items"]) == 1

    # FloorImport: the body is the file, Content-Type chosen from the extension.
    csv_file = ("record_type,name,type,x,y,capacity,is_blocked,is_evacuation_lift,from_node,to_node,distance,"
                "width,max_flow,wheelchair_accessible,stretcher_accessible\n"
                "node,Ward A,ward,0,0,10,false,false,,,,,,,\n"
                "node,Exit 1,exit,10,0,0,false,false,,,,,,,\n"
                "edge,,,,,,false,,Ward A,Exit 1,10,2,60,true,true\n")
    result = call(client, h, "POST", f"/floors/{floor['id']}/import", 201,
                  content=csv_file.encode(), headers={**h, "Content-Type": "text/csv"}).json()
    assert result == {"floor_id": floor["id"], "nodes_imported": 2, "edges_imported": 1}

    # FloorExportLinks: three plain download links.
    for fmt, kind in (("json", "application/json"), ("geojson", "application/geo+json"), ("csv", "text/csv")):
        response = call(client, h, "GET", f"/floors/{floor['id']}/export", 200, params={"format": fmt})
        assert response.headers["content-type"].startswith(kind)
        assert "attachment" in response.headers["content-disposition"]

    # DeleteConfirm: children first gives a readable 409; empty items answer 204 with no body.
    blocked = call(client, h, "DELETE", f"/hospitals/{hospital['id']}", 409).json()
    assert blocked["error"]["message"] == "Delete this hospital's buildings first"
    empty_floor = call(client, h, "POST", "/floors", 201, json={
        "building_id": building["id"], "name": "Roof", "floor_number": 9, "elevation_metres": None}).json()
    assert call(client, h, "DELETE", f"/floors/{empty_floor['id']}", 204).content == b""


def test_onboarding_wizard_requests(client):
    h = admin(client)
    hospital = call(client, h, "POST", "/hospitals", 201,
                    json={"name": "Wizard Hospital", "address": None, "timezone": "UTC"}).json()
    building = call(client, h, "POST", "/buildings", 201,
                    json={"hospital_id": hospital["id"], "name": "Block A", "description": None}).json()
    floor = call(client, h, "POST", "/floors", 201, json={
        "building_id": building["id"], "name": "Ground", "floor_number": 0, "elevation_metres": None}).json()
    graph = call(client, h, "GET", f"/floors/{floor['id']}/graph", 200).json()
    assert graph["nodes"] == []                                  # step 3 not done yet

    plan = {"nodes": [{"name": "Ward A", "type": "ward"}, {"name": "Exit 1", "type": "exit", "x": 10}],
            "edges": [{"from_node": "Ward A", "to_node": "Exit 1", "distance": 10, "width": 2, "max_flow": 60}]}
    call(client, h, "POST", f"/floors/{floor['id']}/import", 201, json=plan)
    nodes = call(client, h, "GET", f"/floors/{floor['id']}/graph", 200).json()["nodes"]
    ward = next(node for node in nodes if node["name"] == "Ward A")

    # Step 4, with a hazard and as a calm drill (no hazards), always with the floor's building.
    for name, hazards in (("First fire", [{"name": "Fire at Ward A", "type": "fire", "origin_node_id": ward["id"],
                                          "severity": 3, "spread_rate": 0.0}]), ("First drill", [])):
        scenario = call(client, h, "POST", "/scenarios", 201, json={"name": name, "hazards": hazards}).json()
        run_id = call(client, h, "POST", "/simulate", 201, json={
            "scenario_id": scenario["id"], "algorithm": "astar", "building_id": building["id"]}).json()["run_id"]
        detail = call(client, h, "GET", f"/simulation_runs/{run_id}", 200).json()
        assert detail["id"] == run_id
        assert {"total", "evacuated", "all_evacuated", "evacuation_time_s"} <= set(detail["summary"])
        assert all({"severity", "text"} <= set(item) for item in detail["recommendations"])
        # The report links offered after the run.
        for fmt in ("pdf", "csv"):
            call(client, h, "GET", f"/reports/{run_id}", 200, params={"format": fmt})

    # Scenario names are unique: the wizard shows this message if one is reused.
    again = call(client, h, "POST", "/scenarios", 409, json={"name": "First drill", "hazards": []}).json()
    assert again["error"]["message"] == "A scenario with this name already exists"

    runs = call(client, h, "GET", "/simulation_runs", 200, params={"limit": 1}).json()
    assert runs["total"] == 2                                    # step 4 done
    dashboard = call(client, h, "GET", "/dashboard", 200).json()
    assert dashboard["hospitals"] == 1 and dashboard["last_run"] is not None
