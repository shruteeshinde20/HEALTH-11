"""Phase 3: routing engine and building-wide route API.

Covers the PROJECT.md Test case for every algorithm, through the service and
through the real API + database, plus mobility rules (including ventilator
patients), multi-floor routes, A* correctness and nearest-exit semantics.
"""

import math
import random
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.db_session import get_db
from app.main import app
from app.services.routing import (
    InvalidRouteRequest,
    NoRouteError,
    find_route,
    nearest_safe_exit,
)

API = "/api/v1"
PASSWORD = "StrongPassword!234"

# --- PROJECT.md Test case (in-memory) ----------------------------------------------------

SPEC_NODES = [
    ("ICU", "icu"), ("WardA", "ward"), ("C1", "corridor"), ("C2", "corridor"),
    ("S1", "stair"), ("S2", "stair"), ("R1", "ramp"), ("R2", "ramp"),
    ("E1", "exit"), ("E2", "exit"),
]
SPEC_EDGES = [
    ("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
    ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
    ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20),
]


def node(i, name, kind, blocked=False, x=None, y=None, floor_id=None):
    return SimpleNamespace(id=i, name=name, type=kind, is_blocked=blocked, x=x, y=y, floor_id=floor_id)


def edge(a, b, distance, wheelchair=True, stretcher=True, blocked=False):
    return SimpleNamespace(from_node_id=a, to_node_id=b, distance=distance, width=1.5,
                           max_flow=10, wheelchair_accessible=wheelchair,
                           stretcher_accessible=stretcher, is_blocked=blocked)


def spec_graph(blocked=(), edge_flags=None):
    edge_flags = edge_flags or {}
    ids = {name: i for i, (name, _) in enumerate(SPEC_NODES, start=1)}
    nodes = [node(ids[n], n, k, blocked=n in blocked) for n, k in SPEC_NODES]
    edges = [edge(ids[a], ids[b], d, **edge_flags.get((a, b), {})) for a, b, d in SPEC_EDGES]
    return nodes, edges


SHORTEST = ("dijkstra", "astar")
EXPECTED = [
    # (blocked, mobility, start, path, metres)
    ((), "ambulatory", "WardA", ["WardA", "C1", "S1", "E1"], 40),
    ((), "stretcher", "ICU", ["ICU", "C1", "R1", "E1"], 43),
    (("C1",), "ambulatory", "WardA", ["WardA", "C2", "S2", "E2"], 47),
    (("C1",), "stretcher", "ICU", ["ICU", "C2", "R2", "E2"], 50),
]


@pytest.mark.parametrize("algorithm", SHORTEST)
@pytest.mark.parametrize("blocked, mobility, start, path, metres", EXPECTED)
def test_spec_test_case_shortest_algorithms(algorithm, blocked, mobility, start, path, metres):
    nodes, edges = spec_graph(blocked)
    result = nearest_safe_exit(nodes, edges, start, mobility=mobility, algorithm=algorithm)
    assert result.node_names == path
    assert result.distance_metres == pytest.approx(metres)


@pytest.mark.parametrize("algorithm", ("bfs", "dfs", "dijkstra", "astar"))
def test_spec_e1_unreachable_when_c1_blocked(algorithm):
    nodes, edges = spec_graph(("C1",))
    for mobility, start in (("ambulatory", "WardA"), ("stretcher", "ICU")):
        with pytest.raises(NoRouteError):
            find_route(nodes, edges, start, "E1", mobility=mobility, algorithm=algorithm)


@pytest.mark.parametrize("algorithm", ("bfs", "dfs"))
@pytest.mark.parametrize("mobility", ("stretcher", "wheelchair", "ventilator"))
def test_bfs_and_dfs_respect_mobility_rules(algorithm, mobility):
    nodes, edges = spec_graph()
    result = nearest_safe_exit(nodes, edges, "ICU", mobility=mobility, algorithm=algorithm)
    assert not {"S1", "S2"} & set(result.node_names)
    assert result.node_names[-1] in {"E1", "E2"}


def test_bfs_minimises_hops():
    nodes, edges = spec_graph()
    result = find_route(nodes, edges, "WardA", "E1", algorithm="bfs")
    assert len(result.node_ids) == 4  # 3 hops is the minimum WardA -> E1


# --- #9 Ventilator patients never use stairs ----------------------------------------------

def test_ventilator_patients_never_use_stairs():
    nodes, edges = spec_graph()
    result = find_route(nodes, edges, "WardA", "E1", mobility="ventilator", algorithm="dijkstra")
    assert result.node_names == ["WardA", "C1", "R1", "E1"]
    assert result.distance_metres == pytest.approx(41)


def test_ventilator_patients_need_stretcher_accessible_edges():
    nodes, edges = spec_graph(edge_flags={("R1", "E1"): {"stretcher": False}})
    result = nearest_safe_exit(nodes, edges, "ICU", mobility="ventilator", algorithm="dijkstra")
    assert result.node_names == ["ICU", "C2", "R2", "E2"]


def test_wheelchair_users_need_wheelchair_accessible_edges():
    nodes, edges = spec_graph(edge_flags={("R1", "E1"): {"wheelchair": False}})
    with pytest.raises(NoRouteError):
        find_route(nodes, edges, "ICU", "E1", mobility="wheelchair")
    # The stretcher flag alone does not matter for wheelchairs.
    assert find_route(nodes, edges, "ICU", "E1", mobility="stretcher").node_names[-1] == "E1"


def test_blocked_edge_is_never_used():
    nodes, edges = spec_graph(edge_flags={("C1", "S1"): {"blocked": True}})
    result = find_route(nodes, edges, "WardA", "E1", algorithm="dijkstra")
    assert result.node_names == ["WardA", "C1", "R1", "E1"]


# --- A* ------------------------------------------------------------------------------------

def _random_graph(rng, scale):
    count = rng.randint(6, 25)
    nodes = [node(i, f"N{i}", "exit" if i == count else "corridor",
                  x=rng.uniform(0, 100) * scale, y=rng.uniform(0, 100) * scale)
             for i in range(1, count + 1)]
    edges, seen = [], set()
    for i in range(2, count + 1):  # spanning tree keeps it connected
        j = rng.randint(1, i - 1)
        seen.add(frozenset((i, j)))
    while len(seen) < count * 2:
        i, j = rng.sample(range(1, count + 1), 2)
        seen.add(frozenset((i, j)))
    for pair in seen:
        i, j = sorted(pair)
        straight = math.dist((nodes[i - 1].x, nodes[i - 1].y), (nodes[j - 1].x, nodes[j - 1].y))
        # Real corridors are at least as long as the straight line (in metres,
        # whatever the coordinate unit), often longer.
        metres = straight / scale * rng.uniform(1.0, 3.0) + rng.uniform(0, 5)
        edges.append(edge(i, j, metres))
    return nodes, edges


@pytest.mark.parametrize("scale", (1.0, 37.5))  # metres, and "pixels"
def test_astar_always_matches_dijkstra_distance(scale):
    rng = random.Random(20261012)
    for _ in range(150):
        nodes, edges = _random_graph(rng, scale)
        start = rng.randint(1, len(nodes) - 1)
        a = find_route(nodes, edges, start, len(nodes), algorithm="astar")
        d = find_route(nodes, edges, start, len(nodes), algorithm="dijkstra")
        assert a.distance_metres == pytest.approx(d.distance_metres)
        a = nearest_safe_exit(nodes, edges, start, algorithm="astar")
        assert a.distance_metres == pytest.approx(d.distance_metres)


def test_astar_without_coordinates_still_finds_shortest():
    nodes, edges = spec_graph()  # no x/y
    result = find_route(nodes, edges, "WardA", "E1", algorithm="astar")
    assert result.distance_metres == pytest.approx(40)


# --- Nearest exit semantics (#25) ------------------------------------------------------

def test_nearest_exit_meaning_depends_on_algorithm():
    # Start -> Far exit is 1 hop but 100 m; Start -> A -> B -> Near exit is 3 hops, 9 m.
    nodes = [node(1, "Start", "room"), node(2, "Far", "exit"), node(3, "A", "corridor"),
             node(4, "B", "corridor"), node(5, "Near", "exit")]
    edges = [edge(1, 2, 100), edge(1, 3, 3), edge(3, 4, 3), edge(4, 5, 3)]
    assert nearest_safe_exit(nodes, edges, "Start", algorithm="bfs").node_names[-1] == "Far"
    for algorithm in SHORTEST:
        result = nearest_safe_exit(nodes, edges, "Start", algorithm=algorithm)
        assert result.node_names == ["Start", "A", "B", "Near"]
        assert result.distance_metres == pytest.approx(9)


def test_start_at_an_exit():
    nodes, edges = spec_graph()
    result = nearest_safe_exit(nodes, edges, "E2")
    assert result.node_names == ["E2"] and result.distance_metres == 0


# --- Clear errors (#26) -------------------------------------------------------------------

@pytest.mark.parametrize("kwargs, message", [
    ({"start": "C1", "blocked": ("C1",)}, "is blocked"),
    ({"start": "S1", "mobility": "stretcher"}, "is a stair"),
    ({"start": "Nowhere"}, "does not exist"),
    ({"start": True}, "by ID or by name"),
    ({"start": "ICU", "mobility": "bed"}, "Unsupported mobility"),
    ({"start": "ICU", "algorithm": "greedy"}, "Unsupported algorithm"),
])
def test_invalid_requests_explain_the_problem(kwargs, message):
    nodes, edges = spec_graph(kwargs.pop("blocked", ()))
    with pytest.raises(InvalidRouteRequest, match=message):
        nearest_safe_exit(nodes, edges, **kwargs)


def test_duplicate_names_across_floors_prefer_the_start_floor():
    nodes = [node(1, "Corridor", "corridor", floor_id=10), node(2, "Exit", "exit", floor_id=10),
             node(3, "Corridor", "corridor", floor_id=20), node(4, "Stair", "stair", floor_id=20)]
    edges = [edge(1, 2, 5), edge(3, 4, 5)]
    assert find_route(nodes, edges, "Corridor", 2, start_floor_id=10).floor_ids == [10, 10]
    with pytest.raises(InvalidRouteRequest, match="more than one floor"):
        find_route(nodes, edges, 1, "Corridor")


# --- Through the real API and database -------------------------------------------------

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
    """An organization with one building, built only through the API."""

    def __init__(self, client, name):
        self.client = client
        body = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Admin",
            "email": "admin@example.com", "password": PASSWORD}).json()
        self.headers = {"Authorization": f"Bearer {body['access_token']}"}
        hospital = self.post("/hospitals", {"name": "Hospital", "timezone": "UTC"})
        self.building = self.post("/buildings", {"hospital_id": hospital["id"], "name": "Main"})
        self.ids = {}

    def post(self, path, payload):
        response = self.client.post(f"{API}{path}", headers=self.headers, json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    def floor(self, number):
        return self.post("/floors", {"building_id": self.building["id"],
                                     "floor_number": number, "name": f"Floor {number}"})["id"]

    def nodes(self, floor_id, spec):
        for name, kind in spec:
            self.ids[(floor_id, name)] = self.post(
                "/nodes", {"floor_id": floor_id, "name": name, "type": kind})["id"]

    def edge(self, a, b, metres, **flags):
        self.post("/edges", {"from_node_id": self.ids[a], "to_node_id": self.ids[b],
                             "distance": metres, "width": 2, "max_flow": 10, **flags})

    def route(self, floor_id, **payload):
        return self.client.post(f"{API}/floors/{floor_id}/route", headers=self.headers, json=payload)


@pytest.fixture
def spec_site(client):
    site = Site(client, "Spec Test Case")
    floor_id = site.floor(0)
    site.nodes(floor_id, SPEC_NODES)
    for a, b, metres in SPEC_EDGES:
        site.edge((floor_id, a), (floor_id, b), metres)
    return site, floor_id


@pytest.mark.parametrize("algorithm", SHORTEST)
def test_spec_test_case_through_the_api(client, spec_site, algorithm):
    site, floor_id = spec_site
    for blocked, mobility, start, path, metres in EXPECTED:
        if blocked:
            response = client.patch(f"{API}/nodes/{site.ids[(floor_id, 'C1')]}",
                                    headers=site.headers, json={"is_blocked": True})
            assert response.status_code == 200
        response = site.route(floor_id, start=start, mobility=mobility, algorithm=algorithm)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["node_names"] == path
        assert body["distance_metres"] == pytest.approx(metres)
        assert body["floor_ids"] == [floor_id] * len(path)

    # With C1 blocked, E1 is unreachable.
    unreachable = site.route(floor_id, start="WardA", destination="E1", algorithm=algorithm)
    assert unreachable.status_code == 422
    assert "No ambulatory-accessible route" in unreachable.json()["error"]["message"]


@pytest.fixture
def two_floor_site(client):
    """Ward on floor 1; ground floor has the exit. Stairs are short, the lift
    is longer; both connect the floors."""
    site = Site(client, "Two Floors")
    ground, upper = site.floor(0), site.floor(1)
    site.nodes(ground, [("Lobby", "corridor"), ("Stair G", "stair"), ("Lift G", "lift"),
                        ("Main Exit", "exit")])
    site.nodes(upper, [("Ward 1", "ward"), ("Corridor 1", "corridor"),
                       ("Stair 1", "stair"), ("Lift 1", "lift")])
    site.edge((upper, "Ward 1"), (upper, "Corridor 1"), 10)
    site.edge((upper, "Corridor 1"), (upper, "Stair 1"), 5)
    site.edge((upper, "Corridor 1"), (upper, "Lift 1"), 20)
    site.edge((upper, "Stair 1"), (ground, "Stair G"), 8)
    site.edge((upper, "Lift 1"), (ground, "Lift G"), 4)
    site.edge((ground, "Stair G"), (ground, "Lobby"), 5)
    site.edge((ground, "Lift G"), (ground, "Lobby"), 6)
    site.edge((ground, "Lobby"), (ground, "Main Exit"), 10)
    return site, ground, upper


def test_routes_go_between_floors(two_floor_site):
    site, ground, upper = two_floor_site
    walking = site.route(upper, start="Ward 1").json()
    assert walking["node_names"] == ["Ward 1", "Corridor 1", "Stair 1", "Stair G", "Lobby", "Main Exit"]
    assert walking["distance_metres"] == pytest.approx(38)
    assert walking["floor_ids"] == [upper, upper, upper, ground, ground, ground]

    for mobility in ("wheelchair", "stretcher", "ventilator"):
        body = site.route(upper, start="Ward 1", mobility=mobility).json()
        assert body["node_names"] == ["Ward 1", "Corridor 1", "Lift 1", "Lift G", "Lobby", "Main Exit"]
        assert body["distance_metres"] == pytest.approx(50)


def test_blocked_lift_leaves_no_route_for_wheelchairs(client, two_floor_site):
    site, ground, upper = two_floor_site
    client.patch(f"{API}/nodes/{site.ids[(ground, 'Lift G')]}", headers=site.headers,
                 json={"is_blocked": True})
    response = site.route(upper, start="Ward 1", mobility="ventilator")
    assert response.status_code == 422
    assert "No reachable safe exit" in response.json()["error"]["message"]
    assert site.route(upper, start="Ward 1").status_code == 200  # stairs still work


def test_destination_on_another_floor_by_name(two_floor_site):
    site, ground, upper = two_floor_site
    body = site.route(upper, start="Ward 1", destination="Lobby", algorithm="dijkstra").json()
    assert body["node_names"][-1] == "Lobby" and body["floor_ids"][-1] == ground


def test_other_buildings_and_organizations_are_not_used(client, two_floor_site):
    site, ground, upper = two_floor_site
    hospital = site.post("/hospitals", {"name": "Other Hospital", "timezone": "UTC"})
    other_building = site.post("/buildings", {"hospital_id": hospital["id"], "name": "Annex"})
    other_floor = site.post("/floors", {"building_id": other_building["id"],
                                        "floor_number": 1, "name": "Annex 1"})["id"]
    site.nodes(other_floor, [("Annex Exit", "exit")])
    response = site.route(upper, start="Ward 1", destination="Annex Exit")
    assert response.status_code == 422  # a node of another building is unknown here

    intruder = Site(client, "Route Intruder")
    response = client.post(f"{API}/floors/{upper}/route", headers=intruder.headers,
                           json={"start": "Ward 1"})
    assert response.status_code == 404
