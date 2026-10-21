"""Phase 5: tick-based simulation, saved runs, algorithm comparison,
dynamic re-routing, dashboard and the authenticated WebSocket stream.

Engine timings below are worked out by hand: an edge of length L walked at
speed v with 1 s ticks takes ceil(L / v) seconds; max_flow people per minute
lets one person in every 60 / max_flow seconds.
"""

import copy
import time
from types import SimpleNamespace as N

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.auth import _password_hash
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, SimulationRun, User, UserRole
from app.services.hazards import hazard_context
from app.services.simulation import ModelSettings, Simulation

API = "/api/v1"
PASSWORD = "StrongPassword!234"
SPEEDS = {"ambulatory": 1.2, "wheelchair": 0.8, "stretcher": 0.5, "ventilator": 0.4}


def settings(speeds=None, max_seconds=3600, risk_cost=50.0):
    return ModelSettings(speeds=speeds or SPEEDS, tick_seconds=1.0, max_seconds=max_seconds,
                         horizon_minutes=5.0, risk_cost_metres=risk_cost, smoke_blocking_severity=4)


def node(i, name, kind, x=0.0, floor_id=1, evac=False):
    return N(id=i, name=name, type=kind, x=float(x), y=0.0, floor_id=floor_id,
             is_blocked=False, is_evacuation_lift=evac)


def edge(i, a, b, metres, max_flow=600, wheelchair=True, stretcher=True):
    return N(id=i, from_node_id=a, to_node_id=b, distance=metres, width=2, max_flow=max_flow,
             wheelchair_accessible=wheelchair, stretcher_accessible=stretcher, is_blocked=False)


def person(pid, node_id, mobility="ambulatory", kind="staff"):
    return N(id=pid, kind=kind, mobility=mobility, node_id=node_id)


def hazard(origin, start_s=0.0, kind="fire", spread=0.0, hazard_id=1):
    return N(id=hazard_id, name="H", type=kind, origin_node_id=origin, spread_rate=spread,
             severity=5, is_active=True, start_minutes=start_s / 60)


def corridor(metres=12, max_flow=60):
    return [node(1, "Ward", "ward"), node(2, "Exit", "exit", x=metres)], [edge(1, 1, 2, metres, max_flow)]


def simulate(nodes, edges, people, hazards=(), algorithm="dijkstra", **kwargs):
    sim = Simulation(nodes, edges, people, list(hazards), algorithm, settings(**kwargs))
    sim.run_to_end()
    return sim


# --- Engine: movement, speeds, queues --------------------------------------------------------

def test_people_walk_at_their_speed_and_queue_first_come_first_served():
    nodes, edges = corridor(12, max_flow=60)  # 60/min = one person per second
    sim = simulate(nodes, edges, [person(f"s{i}", 1) for i in range(3)])
    assert [(a.evacuated_at, a.wait) for a in sim.agents] == [(10, 0), (11, 1), (12, 2)]
    summary = sim.summary()
    assert summary["all_evacuated"] and summary["evacuation_time_s"] == 12
    assert summary["mean_distance_m"] == pytest.approx(12)


def test_slow_corridors_admit_people_at_exact_intervals():
    nodes, edges = corridor(12, max_flow=6)  # one person every 10 s (0.1 per tick adds up)
    sim = simulate(nodes, edges, [person(f"s{i}", 1) for i in range(3)])
    assert [a.wait for a in sim.agents] == [0, 10, 20]


def test_lower_max_flow_means_longer_queues():
    nodes, edges = corridor(12, max_flow=30)  # one person every 2 s
    sim = simulate(nodes, edges, [person(f"s{i}", 1) for i in range(3)])
    assert [a.wait for a in sim.agents] == [0, 2, 4]
    assert sim.congestion_rows()[0]["max_queue"] == 3


@pytest.mark.parametrize("mobility, seconds", [
    ("ambulatory", 9),   # 10 m / 1.2 = 8.3 -> 9 ticks
    ("wheelchair", 13),  # 12.5 -> 13
    ("stretcher", 20),
    ("ventilator", 25),
])
def test_each_mobility_type_uses_its_speed(mobility, seconds):
    nodes, edges = corridor(10)
    sim = simulate(nodes, edges, [person("p", 1, mobility, "patient")])
    assert sim.agents[0].evacuated_at == seconds


def spec_graph():
    names = [("ICU", "icu"), ("WardA", "ward"), ("C1", "corridor"), ("C2", "corridor"),
             ("S1", "stair"), ("S2", "stair"), ("R1", "ramp"), ("R2", "ramp"),
             ("E1", "exit"), ("E2", "exit")]
    ids = {n: i for i, (n, _) in enumerate(names, start=1)}
    links = [("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
             ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
             ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20)]
    nodes = [node(ids[n], n, k) for n, k in names]
    edges = [edge(i, ids[a], ids[b], m) for i, (a, b, m) in enumerate(links, start=1)]
    return nodes, edges, ids


def test_walker_follows_the_spec_route_edge_by_edge():
    nodes, edges, ids = spec_graph()
    sim = simulate(nodes, edges, [person("w", ids["WardA"])])
    agent = sim.agents[0]
    assert agent.initial_route == [ids["WardA"], ids["C1"], ids["S1"], ids["E1"]]
    assert agent.evacuated_at == 7 + 10 + 17  # ceil(8/1.2) + ceil(12/1.2) + ceil(20/1.2)
    assert agent.distance == pytest.approx(40)


def test_stretcher_patient_avoids_stairs_in_simulation():
    nodes, edges, ids = spec_graph()
    sim = simulate(nodes, edges, [person("p", ids["ICU"], "stretcher", "patient")])
    assert sim.agents[0].initial_route == [ids["ICU"], ids["C1"], ids["R1"], ids["E1"]]
    assert sim.agents[0].evacuated_at == 20 + 36 + 30  # 10/0.5 + 18/0.5 + 15/0.5


# --- Engine: hazards and re-routing ---------------------------------------------------------

def test_new_hazard_mid_run_makes_people_reroute():
    nodes, edges, ids = spec_graph()
    sim = simulate(nodes, edges, [person("w", ids["WardA"])], [hazard(ids["S1"], start_s=5)])
    agent = sim.agents[0]
    assert agent.reroutes == 1 and agent.status == "evacuated"
    assert agent.exit_node_id == ids["E1"]
    assert agent.evacuated_at == 7 + 15 + 13  # WardA-C1, then C1-R1-E1 instead of the stair
    assert sim.events == [{"t": 5.0, "unusable_node_ids": [ids["S1"]]}]


def test_person_in_a_corridor_turns_back_when_that_is_safer():
    nodes = [node(1, "A", "room"), node(2, "B", "corridor"), node(3, "E1", "exit"), node(4, "E2", "exit")]
    edges = [edge(1, 1, 2, 20), edge(2, 2, 3, 2), edge(3, 1, 4, 30)]
    sim = simulate(nodes, edges, [person("a", 1)], [hazard(2, start_s=5)],
                   speeds={m: 1.0 for m in SPEEDS}, risk_cost=0)
    agent = sim.agents[0]
    # 5 m towards B, fire at B at 5 s, 5 m back to A, then 30 m to E2.
    assert (agent.status, agent.exit_node_id, agent.evacuated_at, agent.distance) == ("evacuated", 4, 40, 40)


def test_adding_a_hazard_live_matches_a_scheduled_hazard():
    nodes, edges, ids = spec_graph()
    people = [person(f"p{i}", ids["WardA"]) for i in range(5)] + [person("icu", ids["ICU"], "stretcher")]
    scheduled = simulate(nodes, edges, people, [hazard(ids["C1"], start_s=4, spread=2)])

    live = Simulation(nodes, edges, people, [], "dijkstra", settings())
    while live.t < 4:
        live.step()
    live.add_hazard(hazard(ids["C1"], start_s=4, spread=2))
    live.run_to_end()
    assert live.agent_rows() == scheduled.agent_rows()
    assert live.summary() == scheduled.summary()


def test_people_without_a_safe_route_need_assistance():
    nodes = [node(1, "Ward 1", "ward", floor_id=2), node(2, "Lift 1", "lift", floor_id=2),
             node(3, "Lift G", "lift"), node(4, "Exit", "exit"), node(5, "Kitchen", "room")]
    edges = [edge(1, 1, 2, 5), edge(2, 2, 3, 4), edge(3, 3, 4, 5), edge(4, 5, 4, 30)]
    sim = simulate(nodes, edges, [person("wc", 1, "wheelchair", "patient")], [hazard(5)])
    agent = sim.agent_rows()[0]
    assert agent["status"] == "needs_assistance"
    assert "assisted evacuation" in agent["reason"]
    summary = sim.summary()
    assert summary["evacuated"] == 0 and not summary["all_evacuated"]
    assert summary["evacuation_time_s"] is None


def test_people_who_lose_every_route_mid_run_need_assistance():
    # Ward -> Door -> Exit; a queue forms at Door, then fire reaches the Exit.
    nodes = [node(1, "Ward", "ward"), node(2, "Door", "corridor"), node(3, "Exit", "exit")]
    edges = [edge(1, 1, 2, 6), edge(2, 2, 3, 6, max_flow=6)]
    # s0 leaves at 10 s; s1 enters Door-Exit at 15 s and is mid-corridor when
    # the exit catches fire at 18 s, so turns back to Door; s2 is still queuing.
    sim = simulate(nodes, edges, [person(f"s{i}", 1) for i in range(3)], [hazard(3, start_s=18)])
    rows = sim.agent_rows()
    assert [r["status"] for r in rows] == ["evacuated", "needs_assistance", "needs_assistance"]
    assert all("assisted evacuation" in r["reason"] for r in rows[1:])
    assert sim.summary()["evacuated"] == 1


def test_people_where_the_hazard_starts_are_reached_by_it():
    nodes, edges = corridor(12)
    sim = simulate(nodes, edges, [person("a", 1)], [hazard(1)])
    assert sim.summary()["reached_by_hazard"] == 1 and sim.summary()["evacuated"] == 0


def test_hazard_catches_people_still_waiting_in_a_queue():
    nodes, edges = corridor(12, max_flow=6)  # one person every 10 s
    sim = simulate(nodes, edges, [person(f"s{i}", 1) for i in range(4)], [hazard(1, start_s=15)])
    statuses = [a.status for a in sim.agents]
    assert statuses == ["evacuated", "evacuated", "reached_by_hazard", "reached_by_hazard"]


def test_simulation_stops_at_the_time_limit():
    nodes, edges = corridor(100)
    sim = simulate(nodes, edges, [person("a", 1)], max_seconds=30)
    summary = sim.summary()
    assert summary["timed_out"] and summary["still_moving"] == 1 and summary["simulated_seconds"] == 30


def test_simulation_is_deterministic():
    nodes, edges, ids = spec_graph()
    people = [person(f"p{i}", ids["WardA" if i % 2 else "ICU"], "stretcher" if i % 3 == 0 else "ambulatory")
              for i in range(30)]
    first = simulate(nodes, edges, people, [hazard(ids["C2"], start_s=3, spread=1)])
    second = simulate(nodes, edges, people, [hazard(ids["C2"], start_s=3, spread=1)])
    assert first.agent_rows() == second.agent_rows() and first.summary() == second.summary()


def test_frames_show_where_hazards_are_for_drawing():
    nodes, edges, ids = spec_graph()
    sim = Simulation(nodes, edges, [person("a", ids["ICU"])],
                     [hazard(ids["C2"], spread=1.0), hazard(ids["S1"], kind="smoke", spread=0, hazard_id=2)],
                     "dijkstra", settings())
    rows = {row["node_id"]: row for row in sim.step()["hazards"]}
    assert rows[ids["C2"]] == {"node_id": ids["C2"], "types": ["fire"], "reached": True, "risk": 1.0}
    assert rows[ids["S1"]]["types"] == ["smoke"] and rows[ids["S1"]]["reached"] is True
    # WardA is 12 m from C2: the fire gets there in 12 minutes, outside the 5-minute horizon.
    assert ids["WardA"] not in rows
    # S2 is 10 m away (10 minutes): after 6 minutes it is coming (risk 0.2) but not there yet.
    later = hazard_context(nodes, edges, [hazard(ids["C2"], spread=1.0)], 6.0, horizon_minutes=5.0,
                           risk_cost_metres=50.0, smoke_blocking_severity=4)
    assert later.nodes[ids["S2"]].reached_types == () and later.nodes[ids["S2"]].risk == pytest.approx(0.2)
    assert later.nodes[ids["C2"]].reached_types == ("fire",)
    # The saved timeline stays small: no positions and no hazard rows.
    fresh = Simulation(nodes, edges, [person("b", ids["ICU"])], [hazard(ids["C2"])], "dijkstra", settings())
    assert all("hazards" not in f and "positions" not in f for f in fresh.run_to_end(5))


def test_frames_follow_the_contract():
    nodes, edges = corridor(12)
    sim = Simulation(nodes, edges, [person("a", 1)], [], "dijkstra", settings())
    frame = sim.step()
    assert {"t", "total", "evacuated", "positions", "blocked_nodes", "congested_edges",
            "exit_load", "done"} <= set(frame)
    position = frame["positions"][0]
    assert {"id", "x", "y", "mobility"} <= set(position)
    assert position["x"] == pytest.approx(1.2)  # 1.2 m along a 12 m corridor drawn 12 units long


# --- API ---------------------------------------------------------------------------------------

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


SPEC_NODES = [("ICU", "icu"), ("WardA", "ward"), ("C1", "corridor"), ("C2", "corridor"),
              ("S1", "stair"), ("S2", "stair"), ("R1", "ramp"), ("R2", "ramp"),
              ("E1", "exit"), ("E2", "exit")]
SPEC_EDGES = [("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
              ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
              ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20)]


class Site:
    def __init__(self, client, db_session, name, walkers=4):
        self.client, self.db = client, db_session
        body = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Admin",
            "email": "admin@example.com", "password": PASSWORD}).json()
        self.org_id, self.slug = body["organization"]["id"], body["organization"]["slug"]
        self.token = body["access_token"]
        self.headers = {"Authorization": f"Bearer {self.token}"}
        hospital = self.post("/hospitals", {"name": "Hospital", "timezone": "UTC"})
        self.building = self.post("/buildings", {"hospital_id": hospital["id"], "name": "Main"})
        self.floor = self.post("/floors", {"building_id": self.building["id"],
                                           "floor_number": 0, "name": "Ground"})["id"]
        self.ids = {n: self.post("/nodes", {"floor_id": self.floor, "name": n, "type": k,
                                            "x": float(i), "y": 0.0})["id"]
                    for i, (n, k) in enumerate(SPEC_NODES)}
        for a, b, metres in SPEC_EDGES:
            self.post("/edges", {"from_node_id": self.ids[a], "to_node_id": self.ids[b],
                                 "distance": metres, "width": 2, "max_flow": 60})
        for i in range(walkers):
            self.post("/staff", {"staff_code": f"S{i}", "full_name": f"Nurse {i}", "role": "nurse",
                                 "node_id": self.ids["WardA"]})
        self.post("/patients", {"patient_code": "P1", "mobility": "stretcher",
                                "node_id": self.ids["ICU"]})

    def post(self, path, payload, expect=201, headers=None):
        response = self.client.post(f"{API}{path}", headers=headers or self.headers, json=payload)
        assert response.status_code == expect, response.text
        return response.json()

    def scenario(self, name, hazards=()):
        return self.post("/scenarios", {"name": name, "hazards": [
            {"name": f"H{i}", "type": "fire", "origin_node_id": self.ids[origin], **extra}
            for i, (origin, extra) in enumerate(hazards)]})["id"]

    def member(self, role, email):
        self.db.add(User(organization_id=self.org_id, email=email,
                         password_hash=_password_hash(PASSWORD), full_name=email,
                         role=role, is_active=True))
        self.db.flush()
        token = self.client.post(f"{API}/auth/login", json={
            "organization_slug": self.slug, "email": email, "password": PASSWORD}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}, token


def test_simulate_saves_a_complete_run(client, db_session):
    site = Site(client, db_session, "Sim Org")
    scenario = site.scenario("Fire at C1", [("C1", {})])
    run_id = site.post("/simulate", {"scenario_id": scenario, "algorithm": "dijkstra"})["run_id"]
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()

    assert run["building_id"] == site.building["id"] and run["status"] == "completed"
    summary = run["summary"]
    assert summary["total"] == 5 and summary["all_evacuated"] is True
    names = {v: k for k, v in site.ids.items()}
    for route in run["routes"]:
        assert site.ids["C1"] not in route["initial_route"]
    stretcher = next(r for r in run["routes"] if r["mobility"] == "stretcher")
    assert [names[n] for n in stretcher["initial_route"]] == ["ICU", "C2", "R2", "E2"]
    assert stretcher["evacuated_at_s"] == 28 + 32 + 40  # 14/0.5 + 16/0.5 + 20/0.5
    assert summary["evacuation_time_s"] == 100
    assert run["timeline"][0]["t"] == 0 and run["timeline"][-1]["done"] is True
    used = {p["name"]: p for p in run["parameters_used"]}
    assert used["speed_ambulatory_m_per_s"]["value"] == 1.2
    assert used["speed_ventilator_m_per_s"]["source"] == "default (assumed, to be validated)"
    assert run["recommendations"] and any("Not machine learning" in m for m in run["method"])
    assert "simulation.created" in db_session.scalars(
        select(AuditLog.action).where(AuditLog.organization_id == site.org_id)).all()


def test_speeds_come_from_parameters_with_their_source(client, db_session):
    site = Site(client, db_session, "Speed Org", walkers=1)
    site.post("/parameters", {"name": "speed_stretcher_m_per_s", "value": "1.0", "unit": "m/s",
                              "source": "Hospital transport study 2025"})
    scenario = site.scenario("Drill")
    run_id = site.post("/simulate", {"scenario_id": scenario, "algorithm": "dijkstra",
                                     "building_id": site.building["id"]})["run_id"]
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    stretcher = next(r for r in run["routes"] if r["mobility"] == "stretcher")
    assert stretcher["evacuated_at_s"] == 10 + 18 + 15  # ICU-C1-R1-E1 at 1.0 m/s
    used = {p["name"]: p for p in run["parameters_used"]}
    assert used["speed_stretcher_m_per_s"]["source"] == "Hospital transport study 2025"


def test_building_is_required_when_the_scenario_has_no_hazards(client, db_session):
    site = Site(client, db_session, "Building Rule Org", walkers=1)
    scenario = site.scenario("Empty drill")
    response = client.post(f"{API}/simulate", headers=site.headers, json={"scenario_id": scenario})
    assert response.status_code == 422
    assert "building_id is required" in response.json()["error"]["message"]


def test_dynamic_rerouting_through_the_api(client, db_session):
    site = Site(client, db_session, "Reroute Org")
    scenario = site.scenario("Drill")
    run_id = site.post("/simulate", {"scenario_id": scenario, "algorithm": "dijkstra",
                                     "building_id": site.building["id"]})["run_id"]
    before = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()["summary"]

    added = site.post(f"/simulations/{run_id}/hazards", {
        "name": "Fire S1", "type": "fire", "origin_node_id": site.ids["S1"], "at_seconds": 3})
    after = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    assert added["summary"] == after["summary"]
    assert after["summary"]["reroutes"] > before["reroutes"]
    # The walkers lose the stair route (34 s) and take the ramp (35 s); the
    # stretcher patient (86 s) is still the last one out either way.
    walkers_after = [r["evacuated_at_s"] for r in client.get(
        f"{API}/simulation_runs/{run_id}", headers=site.headers).json()["routes"] if r["kind"] == "staff"]
    assert sorted(walkers_after) == [35, 36, 37, 38]  # one per second through the queue
    assert after["summary"]["evacuation_time_s"] == before["evacuation_time_s"] == 86
    assert after["injected_hazards"][0]["origin_node_id"] == site.ids["S1"]
    assert after["hazard_events"][0] == {"t": 3.0, "unusable_node_ids": [site.ids["S1"]]}

    other_building_node = Site(client, db_session, "Other Building Org", walkers=0).ids["C1"]
    bad = client.post(f"{API}/simulations/{run_id}/hazards", headers=site.headers, json={
        "name": "X", "type": "fire", "origin_node_id": other_building_node, "at_seconds": 1})
    assert bad.status_code == 422


def test_compare_runs_every_algorithm(client, db_session):
    site = Site(client, db_session, "Compare Org")
    scenario = site.scenario("Fire C1", [("C1", {})])
    rows = client.post(f"{API}/compare", headers=site.headers, json={"scenario_id": scenario}).json()
    assert [r["algorithm"] for r in rows] == ["bfs", "dfs", "dijkstra", "astar"]
    by = {r["algorithm"]: r for r in rows}
    assert by["dijkstra"]["evacuation_time_s"] == by["astar"]["evacuation_time_s"]
    assert by["dijkstra"]["distance_m"] <= min(r["distance_m"] for r in rows)
    assert all({"evacuation_time_s", "distance_m", "risk"} <= set(r) for r in rows)


def test_dashboard_before_and_after_a_run(client, db_session):
    site = Site(client, db_session, "Dashboard Org")
    empty = client.get(f"{API}/dashboard", headers=site.headers).json()
    assert empty == {"hospitals": 1, "scenarios": 0, "last_evacuation_time_s": None,
                     "bottlenecks": [], "last_run": None, "note": "No simulation has been run yet."}
    scenario = site.scenario("Fire C1", [("C1", {})])
    run_id = site.post("/simulate", {"scenario_id": scenario})["run_id"]
    board = client.get(f"{API}/dashboard", headers=site.headers).json()
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    assert board["scenarios"] == 1 and board["last_run"]["id"] == run_id
    assert board["last_evacuation_time_s"] == run["summary"]["evacuation_time_s"]
    assert isinstance(board["bottlenecks"], list)


def test_dashboard_has_no_evacuation_time_when_people_were_left_behind(client, db_session):
    site = Site(client, db_session, "Incomplete Org", walkers=1)
    # Fire at both corridors next to the ICU and WardA: nobody can leave.
    scenario = site.scenario("ICU cut off", [("C1", {}), ("C2", {})])
    site.post("/staff", {"staff_code": "R", "full_name": "Ramp porter", "role": "porter",
                         "node_id": site.ids["R1"]})  # can still get out
    run_id = site.post("/simulate", {"scenario_id": scenario})["run_id"]
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    # WardA is also only reachable through C1 or C2, so the walker is cut off too.
    assert run["summary"]["needs_assistance"] == 2 and run["summary"]["all_evacuated"] is False
    assert run["summary"]["evacuated"] == 1 and run["summary"]["evacuation_time_s"] is not None
    board = client.get(f"{API}/dashboard", headers=site.headers).json()
    assert board["last_evacuation_time_s"] is None
    assert board["note"] == "The last simulation did not evacuate everyone; see its recommendations."
    assert run["recommendations"][0]["severity"] == "critical"


def test_simulation_roles_and_isolation(client, db_session):
    site = Site(client, db_session, "Roles Sim Org", walkers=1)
    scenario = site.scenario("Fire C1", [("C1", {})])
    run_id = site.post("/simulate", {"scenario_id": scenario})["run_id"]
    staff, _ = site.member(UserRole.STAFF_USER, "staff@example.com")

    assert client.get(f"{API}/simulation_runs/{run_id}", headers=staff).status_code == 200
    assert client.get(f"{API}/dashboard", headers=staff).status_code == 200
    for path, body in (("/simulate", {"scenario_id": scenario}),
                       ("/compare", {"scenario_id": scenario}),
                       (f"/simulations/{run_id}/hazards",
                        {"name": "X", "type": "fire", "origin_node_id": site.ids["C2"], "at_seconds": 1})):
        assert client.post(f"{API}{path}", headers=staff, json=body).status_code == 403

    other = Site(client, db_session, "Other Sim Org", walkers=0)
    assert client.get(f"{API}/simulation_runs/{run_id}", headers=other.headers).status_code == 404
    assert client.get(f"{API}/simulation_runs", headers=other.headers).json()["items"] == []
    assert client.post(f"{API}/simulations/{run_id}/hazards", headers=other.headers, json={
        "name": "X", "type": "fire", "origin_node_id": site.ids["C2"], "at_seconds": 1}).status_code == 404
    assert client.post(f"{API}/simulate", headers=other.headers,
                       json={"scenario_id": scenario}).status_code == 422


# --- WebSocket -------------------------------------------------------------------------------

def ws_url(run_id, token, speed=10_000):
    return f"{API}/ws/simulations/{run_id}?token={token}&speed={speed}"


def test_websocket_streams_ticks_until_done(client, db_session):
    site = Site(client, db_session, "Stream Org")
    scenario = site.scenario("Fire C1", [("C1", {})])
    run_id = site.post("/simulate", {"scenario_id": scenario, "algorithm": "dijkstra"})["run_id"]
    expected = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()["summary"]

    frames = []
    with client.websocket_connect(ws_url(run_id, site.token)) as ws:
        while True:
            frame = ws.receive_json()
            frames.append(frame)
            if frame["done"]:
                break
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1000
    assert frames[0]["t"] == 0 and frames[0]["total"] == 5
    assert site.ids["C1"] in frames[0]["blocked_nodes"]
    assert frames[-1]["t"] == expected["evacuation_time_s"]
    assert frames[-1]["evacuated"] == expected["evacuated"] == 5
    assert all({"id", "x", "y", "mobility"} <= set(p) for f in frames for p in f["positions"])


def test_websocket_pause_and_resume(client, db_session):
    site = Site(client, db_session, "Pause Org")
    scenario = site.scenario("Drill")
    run_id = site.post("/simulate", {"scenario_id": scenario,
                                     "building_id": site.building["id"]})["run_id"]
    with client.websocket_connect(ws_url(run_id, site.token, speed=50)) as ws:
        ws.receive_json()
        ws.send_json({"action": "pause"})
        message = ws.receive_json()
        while message.get("status") != "paused":
            message = ws.receive_json()
        time.sleep(0.3)  # ~15 ticks would be sent at this speed if pause did nothing
        ws.send_json({"action": "resume"})
        assert ws.receive_json()["status"] == "running"  # nothing was sent while paused
        assert "t" in ws.receive_json()
        ws.send_json({"action": "jump"})
        reply = ws.receive_json()
        while "error" not in reply:
            reply = ws.receive_json()
        assert reply["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("who, code", [("bad-token", 4401), ("other-org", 4404), ("missing-run", 4404)])
def test_websocket_rejects_unauthenticated_and_foreign_clients(client, db_session, who, code):
    site = Site(client, db_session, "WS Owner Org", walkers=1)
    run_id = site.post("/simulate", {"scenario_id": site.scenario("D"),
                                     "building_id": site.building["id"]})["run_id"]
    token = {"bad-token": "not-a-token",
             "other-org": Site(client, db_session, "WS Other Org", walkers=0).token,
             "missing-run": site.token}[who]
    target = 999_999 if who == "missing-run" else run_id
    with client.websocket_connect(ws_url(target, token)) as ws:
        error = ws.receive_json()
        assert "error" in error and "positions" not in error
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == code


def test_websocket_staff_user_can_watch(client, db_session):
    site = Site(client, db_session, "WS Staff Org", walkers=1)
    run_id = site.post("/simulate", {"scenario_id": site.scenario("D"),
                                     "building_id": site.building["id"]})["run_id"]
    _, token = site.member(UserRole.STAFF_USER, "watcher@example.com")
    with client.websocket_connect(ws_url(run_id, token)) as ws:
        assert ws.receive_json()["t"] == 0


def test_websocket_replays_hazards_added_to_the_run(client, db_session):
    site = Site(client, db_session, "WS Hazard Org")
    run_id = site.post("/simulate", {"scenario_id": site.scenario("D"),
                                     "building_id": site.building["id"]})["run_id"]
    site.post(f"/simulations/{run_id}/hazards", {
        "name": "Fire S1", "type": "fire", "origin_node_id": site.ids["S1"], "at_seconds": 3})
    with client.websocket_connect(ws_url(run_id, site.token)) as ws:
        frames = [ws.receive_json()]
        while not frames[-1]["done"]:
            frames.append(ws.receive_json())
    first_blocked = next(f["t"] for f in frames if site.ids["S1"] in f["blocked_nodes"])
    assert first_blocked == 4  # frame after the tick that starts at 3 s
    summary = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()["summary"]
    assert frames[-1]["t"] == summary["evacuation_time_s"]


# --- Stream tokens and the run map (Phase 10, group 3: Live Simulation page) -----------------

def test_stream_token_opens_only_the_stream_of_its_own_run(client, db_session):
    site = Site(client, db_session, "Ticket Org", walkers=1)
    run_id = site.post("/simulate", {"scenario_id": site.scenario("D"),
                                     "building_id": site.building["id"]})["run_id"]
    other_run = site.post("/simulate", {"scenario_id": site.scenario("E"),
                                        "building_id": site.building["id"]})["run_id"]
    staff, _ = site.member(UserRole.STAFF_USER, "viewer@example.com")

    # Any signed-in user of the organization may watch, so Staff Users get one too.
    issued = site.post(f"/simulations/{run_id}/stream-token", {}, expect=200, headers=staff)
    from app.config import get_settings
    assert issued["expires_in"] == get_settings().stream_token_expire_seconds and issued["token"]
    with client.websocket_connect(ws_url(run_id, issued["token"])) as ws:
        assert ws.receive_json()["t"] == 0

    # Another run of the same organization: refused like a bad token.
    with client.websocket_connect(ws_url(other_run, issued["token"])) as ws:
        assert ws.receive_json()["error"]["message"] == "This token is for another simulation run"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401

    # It is not an access token: the REST API refuses it.
    bearer = {"Authorization": f"Bearer {issued['token']}"}
    assert client.get(f"{API}/simulation_runs/{run_id}", headers=bearer).status_code == 401

    # Another organization cannot get one for this run (reported as missing).
    other = Site(client, db_session, "Ticket Other Org", walkers=0)
    assert client.post(f"{API}/simulations/{run_id}/stream-token", headers=other.headers).status_code == 404
    assert client.post(f"{API}/simulations/{run_id}/stream-token").status_code == 401


def test_expired_stream_tokens_are_refused(client, db_session, monkeypatch):
    from app.config import get_settings

    site = Site(client, db_session, "Expired Ticket Org", walkers=1)
    run_id = site.post("/simulate", {"scenario_id": site.scenario("D"),
                                     "building_id": site.building["id"]})["run_id"]
    monkeypatch.setattr(get_settings(), "stream_token_expire_seconds", -1)
    token = site.post(f"/simulations/{run_id}/stream-token", {}, expect=200)["token"]
    with client.websocket_connect(ws_url(run_id, token)) as ws:
        assert ws.receive_json()["error"]["message"] == "Invalid or expired token"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401


def test_the_run_map_has_sizes_and_older_runs_get_todays_size_if_unmoved(client, db_session):
    site = Site(client, db_session, "Size Map Org", walkers=1)
    client.patch(f"{API}/nodes/{site.ids['ICU']}", headers=site.headers, json={"width_m": 12, "length_m": 10})
    run_id = site.post("/simulate", {"scenario_id": site.scenario("Fire C1", [("C1", {})]),
                                     "algorithm": "astar"})["run_id"]
    drawn = {n["name"]: n for n in client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers)
             .json()["map"]["nodes"]}
    assert (drawn["ICU"]["width_m"], drawn["ICU"]["length_m"]) == (12, 10)
    assert drawn["C1"]["width_m"] is None

    # A run saved before sizes existed: its snapshot has no width_m / length_m.
    run = db_session.get(SimulationRun, run_id)
    snapshot = copy.deepcopy(run.params["snapshot"])
    for item in snapshot["nodes"]:
        item.pop("width_m"), item.pop("length_m")
    run.params = {**run.params, "snapshot": snapshot}
    db_session.flush()
    client.patch(f"{API}/nodes/{site.ids['WardA']}", headers=site.headers,
                 json={"width_m": 20, "length_m": 12, "x": 500.0})            # sized, but moved since
    drawn = {n["name"]: n for n in client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers)
             .json()["map"]["nodes"]}
    assert (drawn["ICU"]["width_m"], drawn["ICU"]["length_m"]) == (12, 10)    # same place: today's size
    assert drawn["WardA"]["width_m"] is None and drawn["WardA"]["x"] == 1.0   # moved: no size, old position


def test_run_detail_includes_the_building_map_without_people(client, db_session):
    site = Site(client, db_session, "Map Org", walkers=2)
    run_id = site.post("/simulate", {"scenario_id": site.scenario("Fire C1", [("C1", {})]),
                                     "algorithm": "astar"})["run_id"]
    # Renaming a place later does not change the map of a past run.
    assert client.patch(f"{API}/nodes/{site.ids['C1']}", headers=site.headers,
                        json={"name": "Renamed"}).status_code == 200
    run = client.get(f"{API}/simulation_runs/{run_id}", headers=site.headers).json()
    drawn = run["map"]
    assert drawn["building_id"] == site.building["id"]
    assert {n["name"] for n in drawn["nodes"]} == {name for name, _ in SPEC_NODES}
    assert all(set(n) == {"id", "name", "type", "x", "y", "floor_id", "is_blocked", "is_evacuation_lift",
                          "width_m", "length_m"} for n in drawn["nodes"])
    assert all(set(e) == {"id", "from_node_id", "to_node_id", "is_blocked", "distance", "width"}
               for e in drawn["edges"])
    assert len(drawn["edges"]) == len(SPEC_EDGES)
    assert "Nurse" not in str(drawn) and "agents" not in drawn
