from types import SimpleNamespace

import pytest

from app.services.routing import (
    NoRouteError,
    find_route,
    nearest_safe_exit,
)


def make_node(node_id, name, kind, blocked=False):
    return SimpleNamespace(
        id=node_id, name=name, type=kind, is_blocked=blocked
    )


def make_edge(a, b, distance, wheelchair=True, stretcher=True, blocked=False):
    return SimpleNamespace(
        from_node_id=a,
        to_node_id=b,
        distance=distance,
        width=1.5,
        max_flow=10,
        wheelchair_accessible=wheelchair,
        stretcher_accessible=stretcher,
        is_blocked=blocked,
    )


@pytest.fixture
def hospital_graph():
    nodes = [
        make_node(1, "ICU", "icu"),
        make_node(2, "WardA", "ward"),
        make_node(3, "C1", "corridor"),
        make_node(4, "C2", "corridor"),
        make_node(5, "S1", "stair"),
        make_node(6, "S2", "stair"),
        make_node(7, "R1", "ramp"),
        make_node(8, "R2", "ramp"),
        make_node(9, "E1", "exit"),
        make_node(10, "E2", "exit"),
    ]
    edges = [
        make_edge(1, 3, 10),
        make_edge(3, 5, 12),
        make_edge(5, 9, 20),
        make_edge(3, 7, 18),
        make_edge(7, 9, 15),
        make_edge(1, 4, 14),
        make_edge(3, 2, 8),
        make_edge(2, 4, 12),
        make_edge(4, 6, 10),
        make_edge(6, 10, 25),
        make_edge(4, 8, 16),
        make_edge(8, 10, 20),
    ]
    return nodes, edges


def test_ambulatory_route_is_40_metres(hospital_graph):
    nodes, edges = hospital_graph
    result = find_route(nodes, edges, "WardA", "E1", algorithm="dijkstra")
    assert result.node_names == ["WardA", "C1", "S1", "E1"]
    assert result.distance_metres == pytest.approx(40)


def test_stretcher_route_is_43_metres(hospital_graph):
    nodes, edges = hospital_graph
    result = find_route(
        nodes, edges, "ICU", "E1",
        mobility="stretcher", algorithm="dijkstra",
    )
    assert result.node_names == ["ICU", "C1", "R1", "E1"]
    assert result.distance_metres == pytest.approx(43)


def test_blocked_c1_changes_ambulatory_route(hospital_graph):
    nodes, edges = hospital_graph
    nodes = [
        make_node(n.id, n.name, n.type, blocked=(n.name == "C1"))
        for n in nodes
    ]
    result = find_route(nodes, edges, "WardA", "E2", algorithm="dijkstra")
    assert result.node_names == ["WardA", "C2", "S2", "E2"]
    assert result.distance_metres == pytest.approx(47)


def test_blocked_c1_changes_stretcher_route(hospital_graph):
    nodes, edges = hospital_graph
    nodes = [
        make_node(n.id, n.name, n.type, blocked=(n.name == "C1"))
        for n in nodes
    ]
    result = find_route(
        nodes, edges, "ICU", "E2",
        mobility="stretcher", algorithm="dijkstra",
    )
    assert result.node_names == ["ICU", "C2", "R2", "E2"]
    assert result.distance_metres == pytest.approx(50)


def test_stretcher_cannot_use_stairs(hospital_graph):
    nodes, edges = hospital_graph
    result = find_route(
        nodes, edges, "ICU", "E1",
        mobility="stretcher", algorithm="dijkstra",
    )
    assert "S1" not in result.node_names
    assert "S2" not in result.node_names


def test_nearest_safe_exit(hospital_graph):
    nodes, edges = hospital_graph
    result = nearest_safe_exit(
        nodes, edges, "ICU", mobility="stretcher"
    )
    assert result.node_names[-1] == "E1"
    assert result.distance_metres == pytest.approx(43)


def test_no_route_when_all_exits_blocked(hospital_graph):
    nodes, edges = hospital_graph
    nodes = [
        make_node(n.id, n.name, n.type, blocked=(n.name in {"E1", "E2"}))
        for n in nodes
    ]
    with pytest.raises(NoRouteError):
        nearest_safe_exit(nodes, edges, "ICU", mobility="stretcher")
