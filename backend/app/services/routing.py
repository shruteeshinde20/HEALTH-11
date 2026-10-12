"""Evacuation routing on a hospital graph (PROJECT.md, build step 7).

Mobility rules (PROJECT.md Test case, extended to ventilator patients):
- Ambulatory patients may use every node and edge, including stairs.
- Wheelchair, stretcher and ventilator patients cannot pass through any node
  of type "stair". Wheelchair users also need edges flagged
  wheelchair_accessible; stretcher and ventilator patients need edges
  flagged stretcher_accessible (a ventilated patient is moved on a bed).
- Blocked nodes and blocked edges are never used.

Algorithms
- bfs:      fewest edges (hops); distance is reported but not minimised.
- dfs:      the first route found by depth-first search; no optimality.
- dijkstra: shortest total distance.
- astar:    shortest total distance, guided by a straight-line estimate.

A* heuristic: node coordinates may be in any unit (metres, pixels...), so the
estimate is scaled by k = the smallest (edge distance / straight-line length)
over the usable edges. By the triangle inequality, every route from n to t is
at least k * |n - t| long, so the estimate never overestimates and A* returns
the same distance as Dijkstra. Without usable coordinates the estimate is 0.

Nearest safe exit: one search to a virtual node joined to every usable exit
with length 0, so each algorithm keeps its own meaning (BFS: exit with fewest
hops, DFS: first exit reached, Dijkstra/A*: nearest exit by distance).
"""

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import networkx as nx

ALGORITHMS = ("bfs", "dfs", "dijkstra", "astar")
MOBILITIES = ("ambulatory", "wheelchair", "stretcher", "ventilator")

# Mobility types that cannot pass through stair nodes.
NO_STAIRS = frozenset({"wheelchair", "stretcher", "ventilator"})
# Edge flag that must be true for each restricted mobility type.
REQUIRED_EDGE_FLAG = {
    "wheelchair": "wheelchair_accessible",
    "stretcher": "stretcher_accessible",
    "ventilator": "stretcher_accessible",
}

_EXIT_SINK = ("virtual-exit",)  # never collides with integer node IDs
_SAFETY = 1.0 - 1e-9            # guards the heuristic against rounding


class NoRouteError(ValueError):
    """Raised when no safe, accessible route exists."""


class InvalidRouteRequest(ValueError):
    """Raised when a route request is invalid."""


@dataclass(frozen=True)
class RouteResult:
    node_ids: list[int]
    node_names: list[str]
    distance_metres: float
    algorithm: str
    floor_ids: list[int | None] = field(default_factory=list)


def _value(value: Any) -> str:
    """Normalize enum values and strings for consistent comparisons."""
    return str(getattr(value, "value", value)).lower()


def _mobility(mobility: str) -> str:
    mobility = str(mobility).lower()
    if mobility not in MOBILITIES:
        raise InvalidRouteRequest(
            f"Unsupported mobility: {mobility}. Use one of: {', '.join(MOBILITIES)}"
        )
    return mobility


def _algorithm(algorithm: str) -> str:
    algorithm = str(algorithm).lower()
    if algorithm not in ALGORITHMS:
        raise InvalidRouteRequest(
            f"Unsupported algorithm: {algorithm}. Use one of: {', '.join(ALGORITHMS)}"
        )
    return algorithm


def _coordinates(node: Any) -> tuple[float, float] | None:
    x, y = getattr(node, "x", None), getattr(node, "y", None)
    if x is None or y is None:
        return None
    x, y = float(x), float(y)
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return x, y


def build_graph(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    mobility: str = "ambulatory",
) -> nx.Graph:
    """Undirected graph of the nodes and edges usable by `mobility`."""
    mobility = _mobility(mobility)
    graph = nx.Graph()

    for node in nodes:
        if node.is_blocked:
            continue
        if mobility in NO_STAIRS and _value(node.type) == "stair":
            continue
        graph.add_node(
            node.id,
            name=node.name,
            type=_value(node.type),
            xy=_coordinates(node),
            floor_id=getattr(node, "floor_id", None),
        )

    required_flag = REQUIRED_EDGE_FLAG.get(mobility)
    for edge in edges:
        if edge.is_blocked:
            continue
        if edge.from_node_id not in graph or edge.to_node_id not in graph:
            continue
        if required_flag and not getattr(edge, required_flag):
            continue
        graph.add_edge(
            edge.from_node_id,
            edge.to_node_id,
            distance=float(edge.distance),
            width=float(edge.width),
            max_flow=int(edge.max_flow),
        )
    return graph


def _heuristic_scale(graph: nx.Graph) -> float:
    """Largest k such that k * straight-line length <= distance on every edge."""
    scale = math.inf
    for u, v, data in graph.edges(data=True):
        a, b = graph.nodes[u]["xy"], graph.nodes[v]["xy"]
        if a is None or b is None:
            return 0.0
        length = math.dist(a, b)
        if length > 0:
            scale = min(scale, data["distance"] / length)
    return 0.0 if scale is math.inf else scale * _SAFETY


def _why_unusable(node: Any, mobility: str) -> str:
    if node.is_blocked:
        return f"Node {node.name!r} is blocked"
    if mobility in NO_STAIRS and _value(node.type) == "stair":
        return f"Node {node.name!r} is a stair, which {mobility} patients cannot use"
    return f"Node {node.name!r} cannot be used"


def _resolve(
    graph: nx.Graph,
    nodes: Sequence[Any],
    value: int | str,
    mobility: str,
    prefer_floor_id: int | None = None,
) -> int:
    """Turn a node ID or an exact node name into a usable graph node ID."""
    if isinstance(value, bool):
        raise InvalidRouteRequest("A node must be given by ID or by name")

    if isinstance(value, int):
        matches = [node for node in nodes if node.id == value]
    else:
        matches = [node for node in nodes if node.name == value]
        if prefer_floor_id is not None:
            on_floor = [n for n in matches if getattr(n, "floor_id", None) == prefer_floor_id]
            matches = on_floor or matches
        if len(matches) > 1:
            raise InvalidRouteRequest(
                f"Node name {value!r} is used on more than one floor; use its ID"
            )

    if not matches:
        raise InvalidRouteRequest(f"Node {value!r} does not exist")
    node = matches[0]
    if node.id not in graph:
        raise InvalidRouteRequest(_why_unusable(node, mobility))
    return node.id


def _dfs_path(graph: nx.Graph, source: Any, target: Any) -> list:
    parent = {source: None}
    stack = [source]
    while stack and target not in parent:
        current = stack.pop()
        for neighbor in graph.neighbors(current):
            if neighbor not in parent:
                parent[neighbor] = current
                stack.append(neighbor)
    if target not in parent:
        raise nx.NetworkXNoPath
    path, current = [], target
    while current is not None:
        path.append(current)
        current = parent[current]
    path.reverse()
    return path


def _search(
    graph: nx.Graph,
    source: Any,
    target: Any,
    algorithm: str,
    heuristic: Callable[[Any, Any], float],
) -> list:
    if algorithm == "bfs":
        return nx.shortest_path(graph, source, target)
    if algorithm == "dfs":
        return _dfs_path(graph, source, target)
    if algorithm == "dijkstra":
        return nx.dijkstra_path(graph, source, target, weight="distance")
    return nx.astar_path(graph, source, target, heuristic=heuristic, weight="distance")


def _result(graph: nx.Graph, path: list, algorithm: str) -> RouteResult:
    return RouteResult(
        node_ids=list(path),
        node_names=[graph.nodes[n]["name"] for n in path],
        distance_metres=sum(graph[u][v]["distance"] for u, v in zip(path, path[1:])),
        algorithm=algorithm,
        floor_ids=[graph.nodes[n]["floor_id"] for n in path],
    )


def find_route(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    start: int | str,
    destination: int | str,
    mobility: str = "ambulatory",
    algorithm: str = "astar",
    start_floor_id: int | None = None,
) -> RouteResult:
    """Route from `start` to `destination` with BFS, DFS, Dijkstra or A*."""
    algorithm = _algorithm(algorithm)
    mobility = _mobility(mobility)
    graph = build_graph(nodes, edges, mobility)

    source = _resolve(graph, nodes, start, mobility, start_floor_id)
    target = _resolve(graph, nodes, destination, mobility)

    scale = _heuristic_scale(graph)
    target_xy = graph.nodes[target]["xy"]

    def heuristic(node, _goal):
        xy = graph.nodes[node]["xy"]
        if not scale or xy is None or target_xy is None:
            return 0.0
        return scale * math.dist(xy, target_xy)

    try:
        path = _search(graph, source, target, algorithm, heuristic)
    except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
        raise NoRouteError(
            f"No {mobility}-accessible route from {start!r} to {destination!r}"
        ) from exc
    return _result(graph, path, algorithm)


def nearest_safe_exit(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    start: int | str,
    mobility: str = "ambulatory",
    algorithm: str = "astar",
    start_floor_id: int | None = None,
) -> RouteResult:
    """Route to the nearest usable exit (see module docstring for meaning)."""
    algorithm = _algorithm(algorithm)
    mobility = _mobility(mobility)
    graph = build_graph(nodes, edges, mobility)
    source = _resolve(graph, nodes, start, mobility, start_floor_id)

    exits = [n for n, data in graph.nodes(data=True) if data["type"] == "exit"]
    if not exits:
        raise NoRouteError(f"No usable exit for {mobility} patients")
    if source in exits:
        return _result(graph, [source], algorithm)

    scale = _heuristic_scale(graph)
    exit_points = [graph.nodes[e]["xy"] for e in exits]
    use_estimate = bool(scale) and all(p is not None for p in exit_points)

    graph.add_node(_EXIT_SINK, name="", type="virtual", xy=None, floor_id=None)
    for exit_id in exits:
        graph.add_edge(exit_id, _EXIT_SINK, distance=0.0)

    def heuristic(node, _goal):
        xy = graph.nodes[node]["xy"]
        if not use_estimate or xy is None:
            return 0.0
        return scale * min(math.dist(xy, point) for point in exit_points)

    try:
        path = _search(graph, source, _EXIT_SINK, algorithm, heuristic)
    except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
        raise NoRouteError(f"No reachable safe exit from {start!r} for {mobility} patients") from exc
    return _result(graph, path[:-1], algorithm)
