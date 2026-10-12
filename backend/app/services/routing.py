
from dataclasses import dataclass
from typing import Any, Sequence

import networkx as nx


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


def _value(value: Any) -> str:
    """Normalize enum values and strings for consistent comparisons."""
    return str(getattr(value, "value", value)).lower()


def _mobility_restrictions(mobility: str) -> tuple[bool, bool]:
    """Validate mobility and return its accessibility restrictions."""
    mobility = mobility.lower()

    allowed = {"ambulatory", "wheelchair", "stretcher", "ventilator"}
    if mobility not in allowed:
        raise InvalidRouteRequest(
            f"Unsupported mobility: {mobility}"
        )

    # Wheelchairs and stretchers cannot use stairs.
    cannot_use_stairs = mobility in {"wheelchair", "stretcher"}

    return cannot_use_stairs, mobility in {"wheelchair", "stretcher"}


def build_graph(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    mobility: str = "ambulatory",
) -> nx.Graph:
    """Build an undirected graph from persisted Node and Edge records."""
    # Normalize before both validation and accessibility comparisons.
    mobility = mobility.lower()
    cannot_use_stairs, _ = _mobility_restrictions(mobility)

    graph = nx.Graph()

    for node in nodes:
        if node.is_blocked:
            continue

        if cannot_use_stairs and _value(node.type) == "stair":
            continue

        graph.add_node(
            node.id,
            name=node.name,
            type=_value(node.type),
        )

    for edge in edges:
        if edge.is_blocked:
            continue

        # An edge is usable only when both endpoints are in the graph.
        if edge.from_node_id not in graph or edge.to_node_id not in graph:
            continue

        if mobility == "wheelchair" and not edge.wheelchair_accessible:
            continue

        if (
            mobility in {"stretcher", "ventilator"}
            and not edge.stretcher_accessible
        ):
            continue

        graph.add_edge(
            edge.from_node_id,
            edge.to_node_id,
            distance=float(edge.distance),
            width=float(edge.width),
            max_flow=int(edge.max_flow),
        )

    return graph


def find_route(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    start: int | str,
    destination: int | str,
    mobility: str = "ambulatory",
    algorithm: str = "astar",
) -> RouteResult:
    """Find a route using BFS, DFS, Dijkstra, or A*."""
    algorithm = algorithm.lower()

    if algorithm not in {"bfs", "dfs", "dijkstra", "astar"}:
        raise InvalidRouteRequest(
            f"Unsupported algorithm: {algorithm}"
        )

    graph = build_graph(nodes, edges, mobility)

    lookup = {
        node.id: node
        for node in nodes
        if node.id in graph
    }

    def resolve(value: int | str) -> int:
        if isinstance(value, int):
            if value in graph:
                return value
        else:
            matches = [
                node_id
                for node_id, node in lookup.items()
                if node.name == value
            ]

            if len(matches) == 1:
                return matches[0]

            if len(matches) > 1:
                raise InvalidRouteRequest(
                    f"Node name {value!r} is ambiguous; "
                    "use its database ID"
                )

        raise InvalidRouteRequest(
            f"Node {value!r} does not exist or is blocked"
        )

    source = resolve(start)
    target = resolve(destination)

    try:
        if algorithm == "bfs":
            # BFS minimizes the number of edges, not total distance.
            path = nx.shortest_path(graph, source, target)

        elif algorithm == "dfs":
            # DFS finds a reachable path; it does not guarantee
            # the shortest distance or the fewest edges.
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

            path = []
            current = target

            while current is not None:
                path.append(current)
                current = parent[current]

            path.reverse()

        else:
            # A zero heuristic is admissible without reliable
            # geometric distance data. A* therefore behaves like
            # Dijkstra for distance-based routing.
            path = nx.astar_path(
                graph,
                source,
                target,
                heuristic=lambda _a, _b: 0,
                weight="distance",
            )

    except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
        raise NoRouteError(
            f"No accessible route from {start!r} to {destination!r}"
        ) from exc

    distance = sum(
        graph[u][v]["distance"]
        for u, v in zip(path, path[1:])
    )

    return RouteResult(
        node_ids=path,
        node_names=[lookup[node_id].name for node_id in path],
        distance_metres=distance,
        algorithm=algorithm,
    )


def nearest_safe_exit(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    start: int | str,
    mobility: str = "ambulatory",
    algorithm: str = "astar",
) -> RouteResult:
    """Return the shortest-distance reachable, unblocked exit."""
    exits = [
        node
        for node in nodes
        if _value(node.type) == "exit" and not node.is_blocked
    ]

    candidates = []

    for exit_node in exits:
        try:
            candidates.append(
                find_route(
                    nodes,
                    edges,
                    start,
                    exit_node.id,
                    mobility=mobility,
                    algorithm=algorithm,
                )
            )
        except NoRouteError:
            continue

    if not candidates:
        raise NoRouteError(
            f"No reachable safe exit from {start!r}"
        )

    return min(
        candidates,
        key=lambda result: result.distance_metres,
    )
