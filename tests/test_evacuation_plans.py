"""Evacuation plans: saved from a finished simulation run (PROJECT.md data
model, evacuation_plans), listed, approved, archived and deleted, always
inside the caller's organization.

Uses the PROJECT.md Test case floor from test_phase5_simulation (four staff
in WardA, one stretcher patient in the ICU).
"""

from sqlalchemy import select

from app.models import AuditLog, UserRole
from app.models.simulation import SimulationRun
from tests.test_phase5_simulation import API, Site, client  # noqa: F401  (fixture)


def run_for(site, scenario_name, hazards=(), algorithm="dijkstra"):
    scenario = site.scenario(scenario_name, hazards)
    body = {"scenario_id": scenario, "algorithm": algorithm}
    if not hazards:
        body["building_id"] = site.building["id"]
    return scenario, site.post("/simulate", body)["run_id"]


def names_of(site, node_ids):
    by_id = {v: k for k, v in site.ids.items()}
    return [by_id[n] for n in node_ids]


def test_plan_is_saved_from_a_run_with_instructions_by_place_name(client, db_session):
    site = Site(client, db_session, "Plan Org")
    scenario, run_id = run_for(site, "Fire at C1", [("C1", {})])
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()

    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "  Night fire plan  "})

    assert plan["name"] == "Night fire plan" and plan["status"] == "draft"
    assert plan["scenario_id"] == scenario and plan["scenario_name"] == "Fire at C1"
    assert plan["source_run_id"] == run_id and plan["algorithm"] == "dijkstra"
    assert plan["building_id"] == site.building["id"]
    assert plan["summary"] == run["summary"]
    assert (plan["total"], plan["evacuated"], plan["needs_assistance"]) == (5, 5, 0)
    assert plan["evacuation_time_s"] == run["summary"]["evacuation_time_s"] == 100
    assert plan["approved_by"] is None and plan["approved_at"] is None

    # One instruction per starting place, kind, mobility and route; every
    # person of the run is in exactly one of them, with the run's own route.
    instructions = plan["instructions"]
    assert sum(i["people"] for i in instructions) == 5
    for item in instructions:
        assert item["route"] == names_of(site, item["route_node_ids"])
        assert item["start"] == item["route"][0] and item["exit"] == item["route"][-1]
        assert "C1" not in item["route"] and item["needs_assistance"] is False
        matching = [r for r in run["routes"]
                    if r["start_node_id"] == item["start_node_id"] and r["mobility"] == item["mobility"]
                    and r["kind"] == item["kind"] and r["initial_route"] == item["route_node_ids"]]
        assert len(matching) == item["people"]
        assert item["last_out_s"] == max(r["evacuated_at_s"] for r in matching)
    stretcher = next(i for i in instructions if i["mobility"] == "stretcher")
    assert stretcher == {**stretcher, "start": "ICU", "kind": "patient", "people": 1,
                         "route": ["ICU", "C2", "R2", "E2"], "exit": "E2", "last_out_s": 100}
    walkers = [i for i in instructions if i["kind"] == "staff"]
    assert {i["start"] for i in walkers} == {"WardA"} and sum(i["people"] for i in walkers) == 4

    exits = {names_of(site, [int(k)])[0]: v for k, v in run["exit_load"].items()}
    assert plan["exit_load"] == exits and sum(plan["exit_load"].values()) == 5
    assert plan["hazards"] == [{"name": "H0", "type": "fire", "origin": "C1", "severity": 1,
                                "starts_at_s": 0.0}]
    assert plan["bottlenecks"] == run["bottlenecks"]
    assert plan["recommendations"] == run["recommendations"]
    assert plan["parameters_used"] == run["parameters_used"]

    assert client.get(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers).json() == plan
    assert "evacuation_plan.created" in db_session.scalars(
        select(AuditLog.action).where(AuditLog.organization_id == site.org_id)).all()


def test_plan_keeps_its_copy_when_the_run_changes_later(client, db_session):
    site = Site(client, db_session, "Copy Plan Org")
    _, run_id = run_for(site, "Drill")
    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "Drill plan"})

    site.post(f"/simulations/{run_id}/hazards", {
        "name": "Fire S1", "type": "fire", "origin_node_id": site.ids["S1"], "at_seconds": 3})
    changed = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    assert changed["summary"]["reroutes"] > plan["summary"]["reroutes"]

    again = client.get(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers).json()
    assert again["summary"] == plan["summary"] and again["instructions"] == plan["instructions"]
    assert again["hazards"] == []


def test_people_without_a_safe_route_are_listed_first_as_assisted_evacuation(client, db_session):
    site = Site(client, db_session, "Assisted Plan Org", walkers=1)
    # Fire at both corridors: the ICU and WardA are cut off (as in test_phase5).
    _, run_id = run_for(site, "ICU cut off", [("C1", {}), ("C2", {})])
    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "Cut off"})

    assert plan["needs_assistance"] == 2
    assisted = [i for i in plan["instructions"] if i["needs_assistance"]]
    assert plan["instructions"][:len(assisted)] == assisted
    assert {(i["start"], i["mobility"]) for i in assisted} == {("ICU", "stretcher"), ("WardA", "ambulatory")}
    assert all(i["route"] == [] and i["route_node_ids"] == [] and i["exit"] is None
               and i["last_out_s"] is None for i in assisted)


def test_list_filters_search_and_pages(client, db_session):
    site = Site(client, db_session, "List Plan Org", walkers=1)
    fire, fire_run = run_for(site, "Fire at C1", [("C1", {})])
    drill, drill_run = run_for(site, "Drill")
    first = site.post("/evacuation_plans", {"run_id": fire_run, "name": "Fire plan A"})
    second = site.post("/evacuation_plans", {"run_id": fire_run, "name": "Fire plan B"})
    third = site.post("/evacuation_plans", {"run_id": drill_run, "name": "Drill plan"})
    client.patch(f"{API}/evacuation_plans/{second['id']}", headers=site.headers,
                 json={"status": "approved"})

    def ids(query=""):
        page = client.get(f"{API}/evacuation_plans{query}", headers=site.headers).json()
        return [p["id"] for p in page["items"]], page["total"]

    assert ids() == ([third["id"], second["id"], first["id"]], 3)  # newest first
    assert ids(f"?scenario_id={fire}") == ([second["id"], first["id"]], 2)
    assert ids(f"?scenario_id={drill}") == ([third["id"]], 1)
    assert ids("?status=approved") == ([second["id"]], 1)
    assert ids("?status=draft") == ([third["id"], first["id"]], 2)
    assert ids("?q=fire%20plan") == ([second["id"], first["id"]], 2)
    assert ids("?q=%25") == ([], 0)  # % is matched literally
    assert ids("?limit=1&offset=1") == ([second["id"]], 3)
    item = client.get(f"{API}/evacuation_plans", headers=site.headers).json()["items"][0]
    assert item["scenario_name"] == "Drill" and "instructions" not in item
    assert client.get(f"{API}/evacuation_plans?status=done", headers=site.headers).status_code == 422


def test_approve_archive_and_back_to_draft(client, db_session):
    site = Site(client, db_session, "Approve Plan Org", walkers=1)
    _, run_id = run_for(site, "Drill")
    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "Plan"})
    commander, _ = site.member(UserRole.EMERGENCY_COMMANDER, "commander@example.com")

    approved = client.patch(f"{API}/evacuation_plans/{plan['id']}", headers=commander,
                            json={"status": "approved"})
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["status"] == "approved" and body["approved_by"] == "commander@example.com"
    assert body["approved_at"] and body["instructions"] == plan["instructions"]

    archived = client.patch(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers,
                            json={"status": "archived"}).json()
    assert archived["status"] == "archived" and archived["approved_by"] == "commander@example.com"

    draft = client.patch(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers,
                         json={"status": "draft"}).json()
    assert draft["status"] == "draft" and draft["approved_by"] is None and draft["approved_at"] is None

    details = db_session.scalars(select(AuditLog.details).where(
        AuditLog.organization_id == site.org_id, AuditLog.action == "evacuation_plan.updated")).all()
    assert [d["status"] for d in details] == [
        {"from": "draft", "to": "approved"}, {"from": "approved", "to": "archived"},
        {"from": "archived", "to": "draft"}]


def test_names_are_unique_and_updates_are_validated(client, db_session):
    site = Site(client, db_session, "Name Plan Org", walkers=1)
    _, run_id = run_for(site, "Drill")
    first = site.post("/evacuation_plans", {"run_id": run_id, "name": "Plan"})
    second = site.post("/evacuation_plans", {"run_id": run_id, "name": "Other"})

    assert client.post(f"{API}/evacuation_plans", headers=site.headers,
                       json={"run_id": run_id, "name": "Plan"}).status_code == 409
    url = f"{API}/evacuation_plans/{second['id']}"
    assert client.patch(url, headers=site.headers, json={"name": "Plan"}).status_code == 409
    assert client.patch(url, headers=site.headers, json={"name": "Renamed"}).json()["name"] == "Renamed"
    for bad in ({}, {"name": None}, {"status": None}, {"status": "done"}, {"name": "  "},
                {"routes": {}}, {"name": "x" * 201}):
        assert client.patch(url, headers=site.headers, json=bad).status_code == 422, bad
    for bad in ({"run_id": run_id}, {"name": "No run"}, {"run_id": 0, "name": "Zero"},
                {"run_id": run_id, "name": ""}, {"run_id": run_id, "name": "x", "status": "approved"}):
        assert client.post(f"{API}/evacuation_plans", headers=site.headers, json=bad).status_code == 422, bad
    assert client.post(f"{API}/evacuation_plans", headers=site.headers,
                       json={"run_id": 2_000_000_000, "name": "Missing run"}).status_code == 422
    assert client.get(f"{API}/evacuation_plans/{first['id']}", headers=site.headers).json()["name"] == "Plan"


def test_only_completed_runs_can_become_plans(client, db_session):
    site = Site(client, db_session, "Pending Plan Org", walkers=1)
    scenario = site.scenario("Drill")
    pending = SimulationRun(organization_id=site.org_id, scenario_id=scenario, algorithm="astar",
                            params={}, results=None, status="pending")
    db_session.add(pending)
    db_session.flush()
    response = client.post(f"{API}/evacuation_plans", headers=site.headers,
                           json={"run_id": pending.id, "name": "Too early"})
    assert response.status_code == 422
    assert "completed" in response.json()["error"]["message"]


def test_delete_is_soft_and_frees_the_name(client, db_session):
    site = Site(client, db_session, "Delete Plan Org", walkers=1)
    _, run_id = run_for(site, "Drill")
    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "Plan"})

    assert client.delete(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers).status_code == 204
    assert client.get(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers).status_code == 404
    assert client.delete(f"{API}/evacuation_plans/{plan['id']}", headers=site.headers).status_code == 404
    assert client.get(f"{API}/evacuation_plans", headers=site.headers).json()["total"] == 0
    assert site.post("/evacuation_plans", {"run_id": run_id, "name": "Plan"})["id"] != plan["id"]
    assert "evacuation_plan.deleted" in db_session.scalars(
        select(AuditLog.action).where(AuditLog.organization_id == site.org_id)).all()


def test_plan_roles_and_organization_isolation(client, db_session):
    site = Site(client, db_session, "Roles Plan Org", walkers=1)
    _, run_id = run_for(site, "Fire at C1", [("C1", {})])
    plan = site.post("/evacuation_plans", {"run_id": run_id, "name": "Plan"})
    url = f"{API}/evacuation_plans/{plan['id']}"

    staff, _ = site.member(UserRole.STAFF_USER, "staff@example.com")
    assert client.get(f"{API}/evacuation_plans", headers=staff).json()["total"] == 1
    assert client.get(url, headers=staff).status_code == 200
    assert client.post(f"{API}/evacuation_plans", headers=staff,
                       json={"run_id": run_id, "name": "Staff plan"}).status_code == 403
    assert client.patch(url, headers=staff, json={"status": "approved"}).status_code == 403
    assert client.delete(url, headers=staff).status_code == 403
    assert client.get(f"{API}/evacuation_plans").status_code == 401

    other = Site(client, db_session, "Other Plan Org", walkers=0)
    assert client.get(url, headers=other.headers).status_code == 404
    assert client.get(f"{API}/evacuation_plans", headers=other.headers).json()["items"] == []
    assert client.patch(url, headers=other.headers, json={"name": "Taken"}).status_code == 404
    assert client.delete(url, headers=other.headers).status_code == 404
    # Another organization's run cannot be saved as a plan (422, as for every body reference).
    assert client.post(f"{API}/evacuation_plans", headers=other.headers,
                       json={"run_id": run_id, "name": "Stolen"}).status_code == 422
    # The same plan name is allowed in another organization.
    _, other_run = run_for(other, "Drill")
    assert other.post("/evacuation_plans", {"run_id": other_run, "name": "Plan"})["name"] == "Plan"
    assert client.get(url, headers=site.headers).json()["name"] == "Plan"
