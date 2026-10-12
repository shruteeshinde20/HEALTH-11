"""Phase 4: hazard spread, hazard-aware routing, evacuation lifts,
bottleneck detection and recommendations (build step 8)."""

import csv
import io
import math
import random
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.db_session import get_db
from app.main import app
from app.services.bottlenecks import Group, analyse
from app.services.hazards import hazard_context
from app.services.routing import NoRouteError, InvalidRouteRequest, find_route, nearest_safe_exit

API = "/api/v1"
PASSWORD = "StrongPassword!234"
DEFAULTS = {"horizon_minutes": 5.0, "risk_cost_metres": 50.0, "smoke_blocking_severity": 4.0}


def node(i, name, kind, x=None, y=None, floor_id=None, evac=False):
    return SimpleNamespace(id=i, name=name, type=kind, is_blocked=False, x=x, y=y,
                           floor_id=floor_id, is_evacuation_lift=evac)


def edge(i, a, b, distance, max_flow=10, wheelchair=True, stretcher=True):
    return SimpleNamespace(id=i, from_node_id=a, to_node_id=b, distance=distance, width=2,
                           max_flow=max_flow, wheelchair_accessible=wheelchair,
                           stretcher_accessible=stretcher, is_blocked=False)


def hazard(origin, kind="fire", spread=0.0, severity=5, active=True, hazard_id=1):
    return SimpleNamespace(id=hazard_id, origin_node_id=origin, type=kind, spread_rate=spread,
                           severity=severity, is_active=active)


def context(nodes, edges, hazards, minutes=0.0, **overrides):
    return hazard_context(nodes, edges, hazards, minutes, **{**DEFAULTS, **overrides})


# PROJECT.md test-case graph
SPEC_NODES = [("ICU", "icu"), ("WardA", "ward"), ("C1", "corridor"), ("C2", "corridor"),
              ("S1", "stair"), ("S2", "stair"), ("R1", "ramp"), ("R2", "ramp"),
              ("E1", "exit"), ("E2", "exit")]
SPEC_EDGES = [("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
              ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
              ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20)]
ID = {name: i for i, (name, _) in enumerate(SPEC_NODES, start=1)}


def spec_graph():
    nodes = [node(ID[n], n, k) for n, k in SPEC_NODES]
    edges = [edge(i, ID[a], ID[b], d) for i, (a, b, d) in enumerate(SPEC_EDGES, start=1)]
    return nodes, edges


def line_graph():
    nodes = [node(1, "O", "corridor"), node(2, "A", "corridor"), node(3, "B", "exit")]
    return nodes, [edge(1, 1, 2, 10), edge(2, 2, 3, 10)]


# --- Spread model ------------------------------------------------------------------------

def test_hazard_spreads_at_spread_rate_metres_per_minute():
    nodes, edges = line_graph()
    early = context(nodes, edges, [hazard(1, spread=5)], minutes=0)
    assert early.nodes[1].blocked and early.nodes[1].arrival_minutes == 0
    assert early.nodes[2].arrival_minutes == pytest.approx(2)
    assert early.nodes[3].arrival_minutes == pytest.approx(4)
    assert not early.nodes[2].blocked
    assert early.nodes[2].risk == pytest.approx(1.0 * (1 - 2 / 5))  # rising before arrival
    assert early.nodes[3].risk == pytest.approx(1.0 * (1 - 4 / 5))

    later = context(nodes, edges, [hazard(1, spread=5)], minutes=2.5)
    assert later.nodes[2].blocked and not later.nodes[3].blocked


def test_zero_spread_rate_affects_only_the_origin():
    nodes, edges = line_graph()
    state = context(nodes, edges, [hazard(1, spread=0)], minutes=100)
    assert state.blocked_ids == {1}
    assert 2 not in state.nodes or state.nodes[2].risk == 0


def test_smoke_blocks_only_at_high_severity():
    nodes, edges = line_graph()
    light = context(nodes, edges, [hazard(1, kind="smoke", severity=3)])
    assert light.blocked_ids == frozenset() and light.nodes[1].risk == pytest.approx(0.6)
    heavy = context(nodes, edges, [hazard(1, kind="smoke", severity=4)])
    assert heavy.blocked_ids == {1}
    never = context(nodes, edges, [hazard(1, kind="smoke", severity=5)], smoke_blocking_severity=6)
    assert never.blocked_ids == frozenset()


def test_inactive_and_out_of_building_hazards_are_ignored():
    nodes, edges = line_graph()
    state = context(nodes, edges, [hazard(1, active=False, hazard_id=7),
                                   hazard(999, hazard_id=8)])
    assert state.blocked_ids == frozenset()
    assert state.ignored_hazard_ids == [8]


@pytest.mark.parametrize("kind, disabled", [("fire", True), ("smoke", True),
                                            ("hazmat", False), ("structural", False)])
def test_lifts_are_disabled_only_for_fire_and_smoke(kind, disabled):
    nodes, edges = line_graph()
    assert context(nodes, edges, [hazard(1, kind=kind)]).lifts_disabled is disabled


def test_several_hazards_take_the_highest_risk_and_earliest_arrival():
    nodes, edges = line_graph()
    state = context(nodes, edges, [hazard(1, spread=1, severity=2, hazard_id=1),
                                   hazard(3, spread=10, severity=5, hazard_id=2)])
    assert state.nodes[2].arrival_minutes == pytest.approx(1)  # from B at 10 m/min
    # O: its own hazard gives 0.4; the stronger one from B arrives at 2 min,
    # giving 1.0 x (1 - 2/5) = 0.6. The higher value wins.
    assert state.nodes[1].risk == pytest.approx(0.6)


# --- Hazard-aware routing --------------------------------------------------------------

@pytest.mark.parametrize("mobility, start, path, metres", [
    ("ambulatory", "WardA", ["WardA", "C2", "S2", "E2"], 47),
    ("stretcher", "ICU", ["ICU", "C2", "R2", "E2"], 50),
])
def test_fire_at_c1_matches_the_spec_blocked_c1_case(mobility, start, path, metres):
    nodes, edges = spec_graph()
    fire = context(nodes, edges, [hazard(ID["C1"])])
    for algorithm in ("dijkstra", "astar"):
        result = nearest_safe_exit(nodes, edges, start, mobility=mobility,
                                   algorithm=algorithm, hazard=fire)
        assert result.node_names == path
        assert result.distance_metres == pytest.approx(metres)


def test_routes_avoid_nodes_the_hazard_will_reach_soon():
    # Two ways to the exit: via Near (10 + 10 m, next to a fire) or via Far (12 + 12 m).
    nodes = [node(1, "Start", "room"), node(2, "Near", "corridor"), node(3, "Far", "corridor"),
             node(4, "Exit", "exit"), node(5, "Fire", "room")]
    edges = [edge(1, 1, 2, 10), edge(2, 2, 4, 10), edge(3, 1, 3, 12), edge(4, 3, 4, 12),
             edge(5, 5, 2, 4)]
    calm = nearest_safe_exit(nodes, edges, "Start", algorithm="dijkstra")
    assert calm.node_names == ["Start", "Near", "Exit"]

    fire = context(nodes, edges, [hazard(5, spread=2)], minutes=0)  # reaches Near at 2 min
    risky = nearest_safe_exit(nodes, edges, "Start", algorithm="dijkstra", hazard=fire)
    assert risky.node_names == ["Start", "Far", "Exit"]
    assert risky.distance_metres == pytest.approx(24)  # real metres, not cost
    assert risky.risk_cost_metres == pytest.approx(0)


def test_astar_matches_dijkstra_with_hazard_costs():
    rng = random.Random(4)
    for _ in range(100):
        count = rng.randint(6, 20)
        nodes = [node(i, f"N{i}", "exit" if i == count else "corridor",
                      x=rng.uniform(0, 100), y=rng.uniform(0, 100)) for i in range(1, count + 1)]
        pairs = {frozenset((i, rng.randint(1, i - 1))) for i in range(2, count + 1)}
        while len(pairs) < count * 2:
            pairs.add(frozenset(rng.sample(range(1, count + 1), 2)))
        edges = []
        for k, pair in enumerate(pairs, start=1):
            i, j = sorted(pair)
            straight = math.dist((nodes[i - 1].x, nodes[i - 1].y), (nodes[j - 1].x, nodes[j - 1].y))
            edges.append(edge(k, i, j, straight * rng.uniform(1, 2)))
        fire = context(nodes, edges, [hazard(rng.randint(2, count - 1), spread=rng.uniform(1, 20),
                                             kind="smoke", severity=3)])
        a = nearest_safe_exit(nodes, edges, 1, algorithm="astar", hazard=fire)
        d = nearest_safe_exit(nodes, edges, 1, algorithm="dijkstra", hazard=fire)
        assert a.distance_metres + a.risk_cost_metres == pytest.approx(d.distance_metres + d.risk_cost_metres)


def two_floor_graph(evacuation_lift=False):
    nodes = [node(1, "Ward 1", "ward", floor_id=2), node(2, "Stair 1", "stair", floor_id=2),
             node(3, "Lift 1", "lift", floor_id=2, evac=evacuation_lift),
             node(4, "Stair G", "stair", floor_id=1),
             node(5, "Lift G", "lift", floor_id=1, evac=evacuation_lift),
             node(6, "Exit", "exit", floor_id=1), node(7, "Kitchen", "room", floor_id=1)]
    edges = [edge(1, 1, 2, 5), edge(2, 1, 3, 15), edge(3, 2, 4, 8), edge(4, 3, 5, 4),
             edge(5, 4, 6, 5), edge(6, 5, 6, 5), edge(7, 7, 6, 30)]
    return nodes, edges


def test_ordinary_lifts_are_not_used_during_a_fire():
    nodes, edges = two_floor_graph()
    fire = context(nodes, edges, [hazard(7)])  # fire in the kitchen
    walking = nearest_safe_exit(nodes, edges, "Ward 1", hazard=fire)
    assert "Stair 1" in walking.node_names
    with pytest.raises(NoRouteError, match="assisted evacuation"):
        nearest_safe_exit(nodes, edges, "Ward 1", mobility="wheelchair", hazard=fire)
    with pytest.raises(InvalidRouteRequest, match="not marked as an evacuation lift"):
        nearest_safe_exit(nodes, edges, "Lift 1", hazard=fire)


def test_evacuation_lifts_stay_usable_during_a_fire():
    nodes, edges = two_floor_graph(evacuation_lift=True)
    fire = context(nodes, edges, [hazard(7)])
    result = nearest_safe_exit(nodes, edges, "Ward 1", mobility="ventilator", hazard=fire)
    assert result.node_names == ["Ward 1", "Lift 1", "Lift G", "Exit"]


def test_ordinary_lifts_work_for_non_fire_hazards():
    nodes, edges = two_floor_graph()
    leak = context(nodes, edges, [hazard(7, kind="hazmat")])
    result = nearest_safe_exit(nodes, edges, "Ward 1", mobility="wheelchair", hazard=leak)
    assert "Lift 1" in result.node_names


# --- Bottlenecks and recommendations --------------------------------------------------------

def run(groups, hazards=(), nodes_edges=None, **kwargs):
    nodes, edges = nodes_edges or spec_graph()
    state = context(nodes, edges, list(hazards)) if hazards else None
    return analyse(nodes, edges, groups, state, "dijkstra",
                   queue_minutes_threshold=kwargs.get("queue", 2.0),
                   exit_imbalance_share=kwargs.get("share", 0.7))


def edge_row(result, label):
    return next(row for row in result["edges"] if row["label"] == label)


def test_flow_saturation_and_betweenness_on_the_spec_graph():
    result = run([Group(ID["WardA"], "ambulatory", "staff", 20),
                  Group(ID["ICU"], "stretcher", "patient", 3)])
    assert result["people"] == {"total": 23, "routed": 23, "unreachable": 0}

    c1_s1 = edge_row(result, "C1 – S1")
    assert c1_s1["people"] == 20 and c1_s1["queue_minutes"] == pytest.approx(2.0)
    assert c1_s1["is_bottleneck"]
    # Shortest paths: ICU->E1 and WardA->E1 use C1-S1: 2 of 4 (occupied, exit) pairs.
    assert c1_s1["betweenness_share"] == pytest.approx(0.5)
    assert edge_row(result, "ICU – C1")["betweenness_share"] == pytest.approx(0.25)
    assert edge_row(result, "ICU – C1")["people"] == 3
    assert not edge_row(result, "ICU – C1")["is_bottleneck"]
    assert result["exits"] == [{"node_id": ID["E1"], "name": "E1", "people": 23, "share": 1.0}]

    texts = [r["text"] for r in result["recommendations"]]
    assert any("C1 – S1 carries 20 people" in t and "about 2.0 minutes" in t
               and "could use exit E1 instead (+1 m)" in t for t in texts)
    assert any("Exit E1 receives 100% of evacuees (23 of 23)" in t and "E2" in t for t in texts)


def test_queue_minutes_use_each_edges_own_max_flow():
    nodes = [node(1, "Ward", "ward"), node(2, "Door", "corridor"), node(3, "Exit", "exit")]
    edges = [edge(1, 1, 2, 5, max_flow=4), edge(2, 2, 3, 5, max_flow=25)]
    result = run([Group(1, "ambulatory", "staff", 10)], nodes_edges=(nodes, edges))
    narrow, wide = edge_row(result, "Ward – Door"), edge_row(result, "Door – Exit")
    assert narrow["queue_minutes"] == pytest.approx(2.5) and narrow["is_bottleneck"]
    assert wide["queue_minutes"] == pytest.approx(0.4) and not wide["is_bottleneck"]
    assert result["bottleneck_edge_ids"] == [1]


def test_single_point_of_failure_is_reported():
    nodes = [node(1, "Ward", "ward"), node(2, "Corridor", "corridor"), node(3, "Exit", "exit")]
    edges = [edge(1, 1, 2, 5), edge(2, 2, 3, 5, max_flow=100)]
    result = run([Group(1, "ambulatory", "staff", 4)], nodes_edges=(nodes, edges))
    assert edge_row(result, "Ward – Corridor")["cut_off_people"] == 4
    assert any("If Ward – Corridor becomes blocked, 4 people would have no exit" in r["text"]
               for r in result["recommendations"])


def test_unreachable_people_need_assisted_evacuation():
    nodes, edges = two_floor_graph()
    result = run([Group(1, "wheelchair", "patient", 2), Group(1, "ambulatory", "staff", 3)],
                 hazards=[hazard(7)], nodes_edges=(nodes, edges))
    assert result["people"] == {"total": 5, "routed": 3, "unreachable": 2}
    critical = [r for r in result["recommendations"] if r["severity"] == "critical"]
    assert len(critical) == 1
    assert critical[0]["text"].startswith("2 wheelchair patients at Ward 1 have no safe route")
    assert "mark a protected lift as an evacuation lift" in critical[0]["text"]
    assert any("Ordinary lifts are not used" in r["text"] for r in result["recommendations"])


def test_quiet_building_says_so():
    result = run([Group(ID["WardA"], "ambulatory", "staff", 1)], share=1.0)
    assert [r["text"] for r in result["recommendations"]] == [
        "No bottlenecks or unreachable people found with the current parameters."]


# --- API ----------------------------------------------------------------------------------

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


class Site:
    def __init__(self, client, name):
        self.client = client
        body = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Admin",
            "email": "admin@example.com", "password": PASSWORD}).json()
        self.slug = body["organization"]["slug"]
        self.headers = {"Authorization": f"Bearer {body['access_token']}"}
        hospital = self.post("/hospitals", {"name": "Hospital", "timezone": "UTC"})
        self.building = self.post("/buildings", {"hospital_id": hospital["id"], "name": "Main"})
        self.floor = self.post("/floors", {"building_id": self.building["id"],
                                           "floor_number": 0, "name": "Ground"})["id"]
        self.ids = {}
        for name_, kind in SPEC_NODES:
            self.ids[name_] = self.post("/nodes", {"floor_id": self.floor, "name": name_, "type": kind})["id"]
        for a, b, metres in SPEC_EDGES:
            self.post("/edges", {"from_node_id": self.ids[a], "to_node_id": self.ids[b],
                                 "distance": metres, "width": 2, "max_flow": 10})

    def post(self, path, payload, expect=201):
        response = self.client.post(f"{API}{path}", headers=self.headers, json=payload)
        assert response.status_code == expect, response.text
        return response.json()

    def scenario(self, name_, hazards):
        return self.post("/scenarios", {"name": name_, "hazards": [
            {"name": f"H{i}", "origin_node_id": self.ids[origin], **extra}
            for i, (origin, extra) in enumerate(hazards)]})

    def analyse(self, scenario_id, headers=None, **body):
        return self.client.post(f"{API}/scenarios/{scenario_id}/analysis",
                                headers=headers or self.headers,
                                json={"building_id": self.building["id"], **body})


def test_analysis_end_to_end(client):
    site = Site(client, "Analysis Org")
    for i in range(12):
        site.post("/staff", {"staff_code": f"S{i}", "full_name": f"Nurse {i}", "role": "nurse",
                             "node_id": site.ids["WardA"]})
    site.post("/patients", {"patient_code": "P1", "mobility": "stretcher", "node_id": site.ids["ICU"]})
    site.post("/patients", {"patient_code": "P2", "mobility": "ambulatory"})  # no location
    scenario = site.scenario("Fire at C1", [("C1", {"type": "fire", "severity": 5})])

    response = site.analyse(scenario["id"], algorithm="dijkstra")
    assert response.status_code == 200, response.text
    body = response.json()
    blocked = [n["name"] for n in body["hazard"]["nodes"] if n["blocked"]]
    assert blocked == ["C1"] and body["hazard"]["lifts_disabled"] is True
    routes = {r["start_name"]: r for r in body["routes"]}
    assert routes["WardA"]["node_names"] == ["WardA", "C2", "S2", "E2"]
    assert routes["WardA"]["people"] == 12
    assert routes["ICU"]["node_names"] == ["ICU", "C2", "R2", "E2"]
    assert body["people"] == {"total": 13, "routed": 13, "unreachable": 0}
    assert body["unplaced_patients_in_organization"] == 1
    assert edge_row(body, "WardA – C2")["is_bottleneck"] is False  # 12 / 10 = 1.2 min
    assert all(p["source"] == "default (assumed, to be validated)" for p in body["parameters_used"])
    assert any("not machine learning" in line for line in body["method"])


def test_analysis_uses_organization_parameters_with_their_source(client):
    site = Site(client, "Param Org")
    for i in range(12):
        site.post("/staff", {"staff_code": f"S{i}", "full_name": f"N{i}", "role": "nurse",
                             "node_id": site.ids["WardA"]})
    site.post("/parameters", {"name": "bottleneck_queue_minutes", "value": "1",
                              "unit": "min", "source": "Hospital fire plan 2026"})
    scenario = site.scenario("Drill", [])
    body = site.analyse(scenario["id"]).json()
    used = {p["name"]: p for p in body["parameters_used"]}
    assert used["bottleneck_queue_minutes"]["value"] == 1
    assert used["bottleneck_queue_minutes"]["source"] == "Hospital fire plan 2026"
    assert edge_row(body, "C1 – WardA")["is_bottleneck"] is True  # 12 / 10 = 1.2 >= 1

    site.post("/parameters", {"name": "hazard_risk_cost_metres", "value": "lots",
                              "source": "typo"})
    bad = site.analyse(scenario["id"])
    assert bad.status_code == 422
    assert "hazard_risk_cost_metres" in bad.json()["error"]["message"]


def test_analysis_isolation_and_roles(client, db_session):
    site = Site(client, "Owner Org")
    scenario = site.scenario("Owner drill", [])
    other = Site(client, "Other Org")
    assert other.analyse(scenario["id"], headers=other.headers).status_code == 404
    foreign_building = client.post(f"{API}/scenarios/{other.scenario('Mine', [])['id']}/analysis",
                                   headers=other.headers,
                                   json={"building_id": site.building["id"]})
    assert foreign_building.status_code == 422

    from app.auth import _password_hash
    from app.models import User, UserRole
    db_session.add(User(organization_id=client.get(f"{API}/auth/me", headers=site.headers).json()["organization_id"],
                        email="staff@example.com", password_hash=_password_hash(PASSWORD),
                        full_name="Staff", role=UserRole.STAFF_USER, is_active=True))
    db_session.flush()
    token = client.post(f"{API}/auth/login", json={"organization_slug": site.slug,
                                                  "email": "staff@example.com",
                                                  "password": PASSWORD}).json()["access_token"]
    assert site.analyse(scenario["id"], headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_route_endpoint_with_a_scenario(client):
    site = Site(client, "Route Scenario Org")
    fire = site.scenario("Fire C1", [("C1", {"type": "fire"})])
    route = client.post(f"{API}/floors/{site.floor}/route", headers=site.headers,
                        json={"start": "WardA", "scenario_id": fire["id"], "algorithm": "dijkstra"})
    assert route.status_code == 200, route.text
    assert route.json()["node_names"] == ["WardA", "C2", "S2", "E2"]
    assert route.json()["lifts_disabled"] is True

    spreading = site.scenario("Fire S2 spreading", [("S2", {"type": "fire", "spread_rate": 1})])
    later = client.post(f"{API}/floors/{site.floor}/route", headers=site.headers,
                        json={"start": "C2", "destination": "E2", "algorithm": "dijkstra",
                              "scenario_id": spreading["id"], "minutes_elapsed": 5})
    # At 1 m/min the fire has burnt only S2 after 5 minutes (C2 is 10 m away).
    assert later.status_code == 200, later.text
    assert later.json()["node_names"] == ["C2", "R2", "E2"]
    too_late = client.post(f"{API}/floors/{site.floor}/route", headers=site.headers,
                           json={"start": "C2", "scenario_id": spreading["id"],
                                 "minutes_elapsed": 30})
    assert too_late.status_code == 422  # by minute 30 C2 itself has been reached
    blocked_start = client.post(f"{API}/floors/{site.floor}/route", headers=site.headers,
                                json={"start": "S2", "scenario_id": spreading["id"]})
    assert blocked_start.status_code == 422
    assert "reached by the hazard" in blocked_start.json()["error"]["message"]

    other = Site(client, "Other Route Org")
    foreign = client.post(f"{API}/floors/{site.floor}/route", headers=site.headers,
                          json={"start": "WardA", "scenario_id": other.scenario("X", [])["id"]})
    assert foreign.status_code == 422


# --- Evacuation lift flag in the API ----------------------------------------------------------

def test_evacuation_lift_flag_only_for_lifts(client):
    site = Site(client, "Lift Flag Org")
    bad = client.post(f"{API}/nodes", headers=site.headers, json={
        "floor_id": site.floor, "name": "Hall", "type": "corridor", "is_evacuation_lift": True})
    assert bad.status_code == 422
    lift = site.post("/nodes", {"floor_id": site.floor, "name": "Lift A", "type": "lift",
                                "is_evacuation_lift": True})
    assert lift["is_evacuation_lift"] is True
    change = client.patch(f"{API}/nodes/{lift['id']}", headers=site.headers, json={"type": "corridor"})
    assert change.status_code == 422
    both = client.patch(f"{API}/nodes/{lift['id']}", headers=site.headers,
                        json={"type": "corridor", "is_evacuation_lift": False})
    assert both.status_code == 200


def test_evacuation_lift_flag_survives_export_and_import(client):
    site = Site(client, "Lift Export Org")
    site.post("/nodes", {"floor_id": site.floor, "name": "Lift A", "type": "lift",
                         "is_evacuation_lift": True})
    target = site.post("/floors", {"building_id": site.building["id"], "floor_number": 1,
                                   "name": "First"})["id"]
    exported = client.get(f"{API}/floors/{site.floor}/export", headers=site.headers,
                          params={"format": "csv"})
    rows = {row["name"]: row for row in csv.DictReader(io.StringIO(exported.text))}
    assert rows["Lift A"]["is_evacuation_lift"] == "True"
    imported = client.post(f"{API}/floors/{target}/import",
                           headers={**site.headers, "Content-Type": "text/csv"},
                           content=exported.content)
    assert imported.status_code == 201, imported.text
    nodes = client.get(f"{API}/nodes", headers=site.headers,
                       params={"floor_id": target, "q": "Lift A"}).json()["items"]
    assert nodes[0]["is_evacuation_lift"] is True

    bad = client.post(f"{API}/floors/{target}/import",
                      headers={**site.headers, "Content-Type": "application/json"},
                      content=b'{"nodes":[{"name":"X","type":"room","is_evacuation_lift":true}],"edges":[]}')
    assert bad.status_code == 422
