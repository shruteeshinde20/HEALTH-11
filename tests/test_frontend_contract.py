"""Contract test: the exact requests the website sends (frontend/src), checked
against the real API. If the website and the API drift apart, this fails.

Covers the Facility Manager and the onboarding wizard (Phase 10, group 1) and
the Graph Builder and Scenario Builder (group 2), and Live Simulation and
Algorithm Comparison (group 3), and Patients & Staff, AI Assistant and Reports &
History (group 4), and Admin and Settings / Profile (group 5).
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

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


def _building_with_two_floors(client, h):
    hospital = call(client, h, "POST", "/hospitals", 201,
                    json={"name": "Graph Hospital", "address": None, "timezone": "UTC"}).json()
    building = call(client, h, "POST", "/buildings", 201,
                    json={"hospital_id": hospital["id"], "name": "Block G", "description": None}).json()
    floors = [call(client, h, "POST", "/floors", 201, json={
        "building_id": building["id"], "name": name, "floor_number": number, "elevation_metres": None}).json()
        for number, name in ((0, "Ground"), (1, "First"))]
    return building, floors


def place(client, h, floor_id, name, type_, x=0, y=0, **extra):
    # PlaceForm, new place: floor, fields, and the position from newPlacePosition.
    body = {"floor_id": floor_id, "name": name, "type": type_, "capacity": 0, "is_blocked": False,
            "is_evacuation_lift": False, "x": x, "y": y, **extra}
    return call(client, h, "POST", "/nodes", 201, json=body).json()


PATH = {"distance": 12.5, "width": 2, "max_flow": 60,
        "wheelchair_accessible": True, "stretcher_accessible": True, "is_blocked": False}


def test_graph_builder_requests(client):
    h = admin(client)
    building, (ground, first) = _building_with_two_floors(client, h)

    # The page reads the floor graph with every field the canvas and tables show.
    assert call(client, h, "GET", f"/floors/{ground['id']}/graph", 200).json() == {
        "floor_id": ground["id"], "nodes": [], "edges": []}
    ward = place(client, h, ground["id"], "Ward A", "ward", capacity=20)
    exit_ = place(client, h, ground["id"], "Exit 1", "exit", x=80)
    stair = place(client, h, ground["id"], "Stair 1", "stair", x=160)
    lift = place(client, h, ground["id"], "Lift 1", "lift", x=240, is_evacuation_lift=True)
    assert lift["is_evacuation_lift"] is True
    upper_stair = place(client, h, first["id"], "Stair 1 up", "stair")

    # PlaceForm, edit (no floor or position), and a drag that saves x and y rounded to 0.1.
    edited = call(client, h, "PATCH", f"/nodes/{ward['id']}", 200, json={
        "name": "Ward A", "type": "ward", "capacity": 25, "is_blocked": True, "is_evacuation_lift": False}).json()
    assert edited["capacity"] == 25 and edited["is_blocked"] is True
    moved = call(client, h, "PATCH", f"/nodes/{ward['id']}", 200, json={"x": 12.3, "y": -40.7}).json()
    assert (moved["x"], moved["y"], moved["capacity"]) == (12.3, -40.7, 25)

    # PathForm, new (from a drag between two places or from the lists) and edit.
    path = call(client, h, "POST", "/edges", 201,
                json={"from_node_id": ward["id"], "to_node_id": exit_["id"], **PATH}).json()
    call(client, h, "POST", "/edges", 201, json={"from_node_id": exit_["id"], "to_node_id": stair["id"], **PATH})
    changed = call(client, h, "PATCH", f"/edges/{path['id']}", 200,
                   json={**PATH, "distance": 0, "max_flow": 100_000, "wheelchair_accessible": False}).json()
    assert (changed["distance"], changed["max_flow"], changed["wheelchair_accessible"]) == (0, 100_000, False)

    graph = call(client, h, "GET", f"/floors/{ground['id']}/graph", 200).json()
    assert {"id", "floor_id", "name", "type", "x", "y", "capacity", "is_blocked", "is_evacuation_lift"} \
        <= set(graph["nodes"][0])
    assert {"id", "from_node_id", "to_node_id", "distance", "width", "max_flow", "wheelchair_accessible",
            "stretcher_accessible", "is_blocked"} <= set(graph["edges"][0])
    assert len(graph["nodes"]) == 4 and len(graph["edges"]) == 2

    # FloorLinks: the place's edges and the other floors' places, then a link stair to stair.
    paging = {"limit": 200, "offset": 0}
    assert call(client, h, "GET", "/edges", 200, params={"node_id": stair["id"], **paging}).json()["total"] == 1
    others = call(client, h, "GET", "/nodes", 200, params={"floor_id": first["id"], **paging}).json()["items"]
    assert [node["id"] for node in others] == [upper_stair["id"]]
    link = call(client, h, "POST", "/edges", 201,
                json={"from_node_id": stair["id"], "to_node_id": upper_stair["id"], **PATH}).json()
    assert call(client, h, "GET", "/edges", 200, params={"node_id": stair["id"], **paging}).json()["total"] == 2
    # Links between floors are not drawn on either floor's map.
    assert link["id"] not in {e["id"] for e in call(client, h, "GET", f"/floors/{ground['id']}/graph", 200).json()["edges"]}
    assert call(client, h, "GET", f"/floors/{first['id']}/graph", 200).json()["edges"] == []
    # Only stairs, ramps and lifts may link floors; the page shows the API's message.
    refused = call(client, h, "POST", "/edges", 422,
                   json={"from_node_id": ward["id"], "to_node_id": upper_stair["id"], **PATH}).json()
    assert refused["error"]["message"] == "An edge between floors must join two stairs, ramps or lifts"

    # Delete path, then delete place: its remaining paths go with it.
    assert call(client, h, "DELETE", f"/edges/{path['id']}", 204).content == b""
    assert call(client, h, "DELETE", f"/nodes/{stair['id']}", 204).content == b""
    assert call(client, h, "GET", "/edges", 200, params={"node_id": stair["id"], **paging}).json()["total"] == 0
    assert call(client, h, "GET", f"/floors/{ground['id']}/graph", 200).json()["edges"] == []

    # A place that a scenario's hazard starts at cannot be deleted; the page shows why.
    call(client, h, "POST", "/scenarios", 201, json={"name": "Lift fire", "hazards": [{
        "name": "Fire at Lift 1", "type": "fire", "origin_node_id": lift["id"], "severity": 3,
        "spread_rate": 0, "is_active": True}]})
    kept = call(client, h, "DELETE", f"/nodes/{lift['id']}", 409).json()
    assert kept["error"]["message"] == "Move or delete the hazards at this node first"
    assert building["id"]


def test_scenario_builder_requests(client):
    h = admin(client)
    building, (ground, first) = _building_with_two_floors(client, h)
    ward = place(client, h, ground["id"], "Ward A", "ward")
    exit_ = place(client, h, ground["id"], "Exit 1", "exit", x=80)
    call(client, h, "POST", "/edges", 201, json={"from_node_id": ward["id"], "to_node_id": exit_["id"], **PATH})
    lab = place(client, h, first["id"], "Lab", "room")

    # The page loads every node of the organization (no floor filter) to offer places.
    nodes = call(client, h, "GET", "/nodes", 200, params={"limit": 200, "offset": 0}).json()
    assert nodes["total"] == 3

    # Save scenario: name, optional description (null), active flag and the hazards from hazardBodies().
    hazards = [
        {"name": "Fire at Ward A", "type": "fire", "origin_node_id": ward["id"], "spread_rate": 2.5,
         "severity": 4, "is_active": True},
        {"name": "Spill", "type": "hazmat", "origin_node_id": lab["id"], "spread_rate": 0,
         "severity": 1, "is_active": False},
    ]
    scenario = call(client, h, "POST", "/scenarios", 201, json={
        "name": "Night fire", "description": None, "is_active": True, "hazards": hazards}).json()
    assert [(z["name"], z["severity"], z["is_active"]) for z in scenario["hazards"]] == [
        ("Fire at Ward A", 4, True), ("Spill", 1, False)]

    # The list the page shows (apiAll), with hazards and dates.
    listed = call(client, h, "GET", "/scenarios", 200, params={"limit": 200, "offset": 0}).json()["items"]
    assert {"id", "name", "description", "is_active", "hazards", "created_at", "updated_at"} <= set(listed[0])

    # Save again: PATCH replaces the whole hazard list (the editor always sends all of them).
    patched = call(client, h, "PATCH", f"/scenarios/{scenario['id']}", 200, json={
        "name": "Night fire", "description": "Ward A at night", "is_active": False, "hazards": [
            {**hazards[0], "type": "smoke", "name": "Smoke at Ward A", "spread_rate": 1000}]}).json()
    assert patched["description"] == "Ward A at night" and patched["is_active"] is False
    assert [(z["type"], z["spread_rate"]) for z in patched["hazards"]] == [("smoke", 1000)]
    cleared = call(client, h, "PATCH", f"/scenarios/{scenario['id']}", 200, json={
        "name": "Night fire", "description": None, "is_active": True, "hazards": []}).json()
    assert cleared["description"] is None and cleared["hazards"] == []

    # Field errors come back per hazard as "hazards.<index>.<field>" (prefixed() in the page).
    bad = call(client, h, "PATCH", f"/scenarios/{scenario['id']}", 422, json={
        "name": "Night fire", "description": None, "is_active": True,
        "hazards": [hazards[0], {**hazards[1], "spread_rate": 1001}]}).json()
    assert any(d["field"] == "body.hazards.1.spread_rate" for d in bad["error"]["details"])

    # Save and run / Run: the chosen building is always sent, also for a drill with no hazards.
    call(client, h, "PATCH", f"/scenarios/{scenario['id']}", 200, json={
        "name": "Night fire", "description": None, "is_active": True, "hazards": hazards})
    for algorithm in ("bfs", "dfs", "dijkstra", "astar"):
        run_id = call(client, h, "POST", "/simulate", 201, json={
            "scenario_id": scenario["id"], "algorithm": algorithm, "building_id": building["id"]}).json()["run_id"]
        detail = call(client, h, "GET", f"/simulation_runs/{run_id}", 200).json()
        assert detail["algorithm"] == algorithm and "summary" in detail and "recommendations" in detail

    # Delete from the list.
    assert call(client, h, "DELETE", f"/scenarios/{scenario['id']}", 204).content == b""
    assert call(client, h, "GET", "/scenarios", 200, params={"limit": 200, "offset": 0}).json()["total"] == 0


def test_staff_users_only_read_graphs_and_scenarios(client):
    registered = client.post(f"{API}/auth/register-organization", json={
        "organization_name": "Contract Org", "full_name": "Admin",
        "email": "admin@example.com", "password": PASSWORD}).json()
    h = {"Authorization": f"Bearer {registered['access_token']}"}
    building, (ground, _first) = _building_with_two_floors(client, h)
    ward = place(client, h, ground["id"], "Ward A", "ward")
    call(client, h, "POST", "/users", 201, json={
        "email": "staff@example.com", "full_name": "Staff", "password": PASSWORD, "role": "Staff User"})
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": registered["organization"]["slug"],
        "email": "staff@example.com", "password": PASSWORD})
    assert login.status_code == 200, login.text
    staff = {"Authorization": f"Bearer {login.json()['access_token']}"}

    call(client, staff, "GET", f"/floors/{ground['id']}/graph", 200)
    call(client, staff, "GET", "/scenarios", 200, params={"limit": 200, "offset": 0})
    call(client, staff, "PATCH", f"/nodes/{ward['id']}", 403, json={"x": 1, "y": 1})
    call(client, staff, "POST", "/scenarios", 403, json={"name": "No", "hazards": []})
    assert building["id"]


def _site_with_people(client, h):
    building, (ground, first) = _building_with_two_floors(client, h)
    ward = place(client, h, ground["id"], "Ward A", "ward")
    corridor = place(client, h, ground["id"], "C1", "corridor", x=40)
    exit_ = place(client, h, ground["id"], "Exit 1", "exit", x=80)
    for a, b in ((ward, corridor), (corridor, exit_)):
        call(client, h, "POST", "/edges", 201, json={"from_node_id": a["id"], "to_node_id": b["id"], **PATH})
    for i in range(3):
        call(client, h, "POST", "/staff", 201, json={"staff_code": f"S{i}", "full_name": f"Nurse {i}",
                                                     "role": "nurse", "node_id": ward["id"]})
    scenario = call(client, h, "POST", "/scenarios", 201, json={"name": "Live drill", "hazards": []}).json()
    return building, ground, {"ward": ward, "corridor": corridor, "exit": exit_}, scenario


def test_live_simulation_requests(client):
    h = admin(client)
    building, ground, places, scenario = _site_with_people(client, h)
    run_id = call(client, h, "POST", "/simulate", 201, json={
        "scenario_id": scenario["id"], "algorithm": "astar", "building_id": building["id"]}).json()["run_id"]

    # The run picker (useApi, limit 50) and the run with its map.
    runs = call(client, h, "GET", "/simulation_runs", 200, params={"limit": 50}).json()
    assert runs["items"][0]["id"] == run_id
    run = call(client, h, "GET", f"/simulation_runs/{run_id}", 200).json()
    assert {n["name"] for n in run["map"]["nodes"]} == {"Ward A", "C1", "Exit 1"}
    assert {n["floor_id"] for n in run["map"]["nodes"]} == {ground["id"]}
    assert run["injected_hazards"] == []
    # Reports & History draws the saved timeline (EvacuationTimeline) and shows it as a table.
    assert len(run["timeline"]) >= 2 and run["timeline"][0]["t"] == 0
    assert all({"t", "evacuated", "active", "needs_assistance", "reached_by_hazard"} <= set(f) for f in run["timeline"])
    assert run["timeline"][-1]["evacuated"] == 3

    # /api/session/stream asks for a stream token with no body, then the browser opens the URL
    # (speed is one of STREAM_SPEEDS in frontend/src/lib/shared/live.ts).
    issued = call(client, h, "POST", f"/simulations/{run_id}/stream-token", 200).json()
    with client.websocket_connect(f"{API}/ws/simulations/{run_id}?token={issued['token']}&speed=60") as ws:
        first = ws.receive_json()
        # Every field parseStreamMessage() reads.
        assert {"t", "total", "evacuated", "active", "needs_assistance", "reached_by_hazard",
                "blocked_nodes", "congested_edges", "exit_load", "done", "positions"} <= set(first)
        assert first["total"] == 3
        assert {"id", "x", "y", "floor_id", "mobility", "status"} <= set(first["positions"][0])
        ws.send_json({"action": "pause"})
        reply = ws.receive_json()
        while "status" not in reply:
            reply = ws.receive_json()
        assert reply["status"] == "paused" and isinstance(reply["t"], (int, float))
        ws.send_json({"action": "resume"})
        frames = [ws.receive_json()]
        while not frames[-1].get("done"):
            frames.append(ws.receive_json())
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1000
    assert frames[-1]["evacuated"] == 3
    assert set(frames[-1]["exit_load"]) == {str(places["exit"]["id"])}   # exit ids as text keys

    # AddHazard: name from hazardName(), at_seconds from the form (empty = now, rounded up).
    added = call(client, h, "POST", f"/simulations/{run_id}/hazards", 201, json={
        "name": "Fire at C1", "type": "fire", "origin_node_id": places["corridor"]["id"],
        "severity": 3, "spread_rate": 0, "at_seconds": 5}).json()
    assert added["run_id"] == run_id and added["summary"]["total"] == 3
    after = call(client, h, "GET", f"/simulation_runs/{run_id}", 200).json()
    assert [z["name"] for z in after["injected_hazards"]] == ["Fire at C1"]


def test_algorithm_comparison_requests(client):
    h = admin(client)
    building, _ground, _places, scenario = _site_with_people(client, h)
    rows = call(client, h, "POST", "/compare", 200,
                json={"scenario_id": scenario["id"], "building_id": building["id"]}).json()
    # Every field of the Comparison type, for the four algorithms the page explains.
    assert [r["algorithm"] for r in rows] == ["bfs", "dfs", "dijkstra", "astar"]
    assert all(set(r) == {"algorithm", "evacuation_time_s", "distance_m", "risk", "all_evacuated",
                          "evacuated", "total", "needs_assistance", "reached_by_hazard"} for r in rows)
    assert all(r["total"] == 3 and r["all_evacuated"] for r in rows)
    # Nothing was saved by comparing.
    assert call(client, h, "GET", "/simulation_runs", 200, params={"limit": 1}).json()["total"] == 0
    # "Run and watch" saves a run with the chosen algorithm.
    run_id = call(client, h, "POST", "/simulate", 201, json={
        "scenario_id": scenario["id"], "algorithm": "bfs", "building_id": building["id"]}).json()["run_id"]
    assert call(client, h, "GET", f"/simulation_runs/{run_id}", 200).json()["algorithm"] == "bfs"


def test_patients_and_staff_requests(client):
    h = admin(client)
    building, ground, places, _scenario = _site_with_people(client, h)   # 3 staff in Ward A
    # PatientForm, "How many" = 2: codes N-1, N-2, one POST each; "Not placed" sends node_id null.
    for code in ("N-1", "N-2"):
        call(client, h, "POST", "/patients", 201, json={"patient_code": code, "mobility": "stretcher",
                                                        "criticality": 4, "node_id": places["ward"]["id"],
                                                        "is_synthetic": True})
    loose = call(client, h, "POST", "/patients", 201, json={"patient_code": "P9", "mobility": "ventilator",
                                                            "criticality": 5, "node_id": None,
                                                            "is_synthetic": False}).json()
    # A reused code is refused with a readable message (shown as "1 of 2 were added; then: ...").
    again = call(client, h, "POST", "/patients", 409, json={"patient_code": "N-1", "mobility": "ambulatory",
                                                            "criticality": 3, "node_id": None,
                                                            "is_synthetic": False}).json()
    assert again["error"]["message"] == "A patient with this code already exists"
    # Edit: every field, placing and un-placing.
    edited = call(client, h, "PATCH", f"/patients/{loose['id']}", 200, json={
        "patient_code": "P9", "mobility": "wheelchair", "criticality": 2,
        "node_id": places["corridor"]["id"], "is_synthetic": False}).json()
    assert (edited["mobility"], edited["node_id"]) == ("wheelchair", places["corridor"]["id"])
    unplaced = call(client, h, "PATCH", f"/patients/{loose['id']}", 200, json={
        "patient_code": "P9", "mobility": "wheelchair", "criticality": 2, "node_id": None, "is_synthetic": False}).json()
    assert unplaced["node_id"] is None

    # The lists (apiAll) with every field the tables show.
    patients = call(client, h, "GET", "/patients", 200, params={"limit": 200, "offset": 0}).json()["items"]
    assert {"id", "patient_code", "mobility", "criticality", "node_id", "is_synthetic"} <= set(patients[0])
    staff = call(client, h, "GET", "/staff", 200, params={"limit": 200, "offset": 0}).json()["items"]
    assert {"id", "staff_code", "full_name", "role", "node_id", "is_synthetic"} <= set(staff[0])
    member = call(client, h, "PATCH", f"/staff/{staff[0]['id']}", 200, json={
        "staff_code": staff[0]["staff_code"], "full_name": "Asha Rao", "role": "doctor",
        "node_id": None, "is_synthetic": True}).json()
    assert member["node_id"] is None and member["is_synthetic"] is True

    # Evacuation priority: without a scenario, and with one (building chosen on the page).
    fire = call(client, h, "POST", "/scenarios", 201, json={"name": "Ward fire", "hazards": [{
        "name": "Fire at Ward A", "type": "fire", "origin_node_id": places["ward"]["id"],
        "severity": 4, "spread_rate": 0}]}).json()
    plain = call(client, h, "GET", "/patient_priority", 200, params={"limit": 200}).json()
    assert plain["total"] == 3 and plain["scenario_id"] is None
    ranked = call(client, h, "GET", "/patient_priority", 200, params={
        "limit": 200, "scenario_id": fire["id"], "building_id": building["id"]}).json()
    assert ranked["total"] == 2                       # P9 is not placed, so not in this building
    row = ranked["items"][0]
    assert {"rank", "patient_id", "patient_code", "node_id", "is_synthetic", "score", "breakdown"} <= set(row)
    for part in ("mobility", "criticality", "hazard"):
        assert {"factor", "weight", "points"} <= set(row["breakdown"][part])
    assert row["breakdown"]["hazard"]["explanation"] == "0 m from the nearest hazard origin"
    assert {"name", "value", "unit", "source", "meaning"} <= set(ranked["parameters_used"][0])
    assert ranked["method"]

    # Delete from the lists.
    assert call(client, h, "DELETE", f"/patients/{loose['id']}", 204).content == b""
    assert call(client, h, "DELETE", f"/staff/{staff[0]['id']}", 204).content == b""
    assert ground["id"]


def test_ai_assistant_requests(client):
    from app.assistant_api import get_language_model

    class StandIn:
        def __init__(self, *replies):
            self.replies = list(replies)

        def complete_json(self, system, user_content, schema, max_tokens):
            return self.replies.pop(0)

    h = admin(client)
    building, ground, places, _scenario = _site_with_people(client, h)
    stand_in = StandIn(
        {"status": "clarification", "clarification_question": "Which corridor?", "unknown_names": ["C9"],
         "scenario_name": "", "scenario_description": "", "hazards": []},
        {"status": "scenario", "clarification_question": "", "unknown_names": [],
         "scenario_name": "Corridor fire", "scenario_description": "Reported by phone",
         "hazards": [{"node_name": "c1", "type": "Fire", "severity": 4, "spread_rate_m_per_min": 2}]},
        {"summary": "Everyone got out."},
    )
    app.dependency_overrides[get_language_model] = lambda: stand_in
    # A question back: DraftResult shows clarification and unknown_names.
    asked = call(client, h, "POST", "/assistant", 200, json={"text": "fire in C9", "floor_id": ground["id"]}).json()
    assert asked["clarification"] == "Which corridor?" and asked["unknown_names"] == ["C9"]
    assert "scenario" not in asked and asked["method"] and "data_notice" in asked
    # A draft: every field the table and "Run it" use.
    drafted = call(client, h, "POST", "/assistant", 200, json={"text": "fire in c1", "floor_id": ground["id"]}).json()
    hazard = drafted["scenario"]["hazards"][0]
    assert set(hazard) == {"name", "type", "origin_node_id", "origin_node_name", "severity", "spread_rate"}
    assert (hazard["origin_node_name"], hazard["type"]) == ("C1", "fire")
    assert drafted["note"] and drafted["floor_id"] == ground["id"]
    # "Run it": the page drops origin_node_name, saves the scenario, then simulates the floor's building.
    created = call(client, h, "POST", "/scenarios", 201, json={
        "name": drafted["scenario"]["name"], "description": drafted["scenario"]["description"],
        "hazards": [{k: v for k, v in hazard.items() if k != "origin_node_name"}]}).json()
    run_id = call(client, h, "POST", "/simulate", 201, json={
        "scenario_id": created["id"], "algorithm": "astar", "building_id": building["id"]}).json()["run_id"]
    # Explain a run.
    explained = call(client, h, "POST", "/assistant/summary", 200, json={"run_id": run_id}).json()
    assert set(explained) >= {"run_id", "summary", "source", "note", "method", "data_notice"}
    assert explained["source"] in ("ai", "standard")


def test_reports_and_history_requests(client):
    h = admin(client)
    building, _ground, _places, scenario = _site_with_people(client, h)
    other = call(client, h, "POST", "/scenarios", 201, json={"name": "Other", "hazards": []}).json()
    for scenario_id in (scenario["id"], scenario["id"], other["id"]):
        call(client, h, "POST", "/simulate", 201, json={
            "scenario_id": scenario_id, "algorithm": "astar", "building_id": building["id"]})
    # History: 20 per page, newest first, optional scenario filter.
    page = call(client, h, "GET", "/simulation_runs", 200, params={"limit": 20, "offset": 0}).json()
    assert page["total"] == 3 and [r["id"] for r in page["items"]] == sorted((r["id"] for r in page["items"]), reverse=True)
    filtered = call(client, h, "GET", "/simulation_runs", 200,
                    params={"limit": 20, "offset": 0, "scenario_id": scenario["id"]}).json()
    assert filtered["total"] == 2
    assert {"id", "scenario_id", "algorithm", "status", "created_at", "summary"} <= set(page["items"][0])
    # Predictor: not enough runs yet, so no number, a note, and no "about" figures.
    answer = call(client, h, "POST", "/predict", 200, json={
        "scenario_id": scenario["id"], "building_id": building["id"], "algorithm": "astar"}).json()
    assert answer["predicted_time_s"] is None and answer["note"].startswith("Not enough data")
    assert set(answer) >= {"method", "mae", "r2", "about"} and answer["about"] is None
    # Alerts: fewer than 50 runs gives the "more data needed" message.
    alerts = call(client, h, "GET", "/alerts", 200).json()
    assert alerts["message"].startswith("More data needed") and alerts["runs_considered"] == 3
    assert alerts["method"]


def test_admin_requests(client):
    h = admin(client)
    me = call(client, h, "GET", "/auth/me", 200).json()
    # UserForm, add: name, email, role label, first password.
    added = call(client, h, "POST", "/users", 201, json={
        "full_name": "Ravi Kumar", "email": "ravi@example.com", "role": "Emergency Commander",
        "password": "FirstPassword#123"}).json()
    assert added["role"] == "Emergency Commander" and added["is_active"] is True
    # UserForm, edit: name and role, active flag, and an optional new password.
    edited = call(client, h, "PATCH", f"/users/{added['id']}", 200, json={
        "full_name": "Ravi K", "role": "Staff User", "is_active": False, "password": "ResetPassword#456"}).json()
    assert (edited["full_name"], edited["role"], edited["is_active"]) == ("Ravi K", "Staff User", False)
    # Editing yourself never sends is_active; the API also refuses self-deactivation and losing the last admin.
    call(client, h, "PATCH", f"/users/{me['id']}", 200, json={"full_name": "Admin", "role": "Administrator"})
    refused = call(client, h, "PATCH", f"/users/{me['id']}", 409, json={"full_name": "Admin", "role": "Staff User"}).json()
    assert refused["error"]["message"] == "The organization must keep at least one active Administrator"
    # The list (apiAll) and delete.
    users = call(client, h, "GET", "/users", 200, params={"limit": 200, "offset": 0}).json()["items"]
    assert {"id", "email", "full_name", "role", "is_active", "created_at"} <= set(users[0])
    assert call(client, h, "DELETE", f"/users/{added['id']}", 204).content == b""

    # Audit log: 50 per page, newest first, exact filters; details never hold passwords.
    page = call(client, h, "GET", "/audit_log", 200, params={"limit": 50, "offset": 0}).json()
    assert page["total"] >= 5
    entry = page["items"][0]
    assert {"id", "created_at", "actor_user_id", "action", "entity_type", "entity_id", "details", "ip_address"} <= set(entry)
    updates = call(client, h, "GET", "/audit_log", 200, params={
        "limit": 50, "offset": 0, "action": "user.updated", "entity_type": "user", "actor_user_id": me["id"]}).json()
    assert updates["total"] >= 2 and all(e["action"] == "user.updated" for e in updates["items"])
    assert "Password#" not in str(page)


def test_settings_requests(client):
    h = admin(client)
    # Profile: PATCH /auth/me through the /api/backend proxy (auth/me is allowed there).
    assert call(client, h, "PATCH", "/auth/me", 200, json={"full_name": "New Name"}).json()["full_name"] == "New Name"
    # /api/session/password sends this body and stores the returned tokens.
    changed = call(client, h, "POST", "/auth/change-password", 200, json={
        "current_password": PASSWORD, "new_password": "NewStrongPass#987"}).json()
    assert {"access_token", "refresh_token", "expires_in", "user"} <= set(changed)
    h = {"Authorization": f"Bearer {changed['access_token']}"}

    # Model parameters: specs, then POST for the first own value, PATCH to change it, DELETE for "Use default".
    specs = call(client, h, "GET", "/parameters/specs", 200).json()
    spec = next(s for s in specs if s["name"] == "speed_wheelchair_m_per_s")
    assert set(spec) == {"name", "default", "unit", "minimum", "maximum", "meaning"}
    saved = call(client, h, "POST", "/parameters", 201, json={
        "name": spec["name"], "value": "0.7", "unit": spec["unit"], "source": "assumed, to be validated"}).json()
    call(client, h, "PATCH", f"/parameters/{saved['id']}", 200, json={"value": "0.75", "source": "Local drill 2026"})
    stored = call(client, h, "GET", "/parameters", 200, params={"limit": 200, "offset": 0}).json()["items"]
    assert [(p["name"], p["value"], p["source"]) for p in stored] == [(spec["name"], "0.75", "Local drill 2026")]
    assert call(client, h, "DELETE", f"/parameters/{saved['id']}", 204).content == b""
