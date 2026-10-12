"""Bottleneck detection and plain-language recommendations
(PROJECT.md: betweenness centrality plus flow saturation).

Inputs: the building graph, the people placed in it (patients by mobility,
staff as ambulatory), the hazard state at one moment and model parameters.

Steps
1. Every group of people (same node, same mobility) is routed to its nearest
   safe exit with the chosen algorithm. Groups with no safe route are
   reported as needing assisted evacuation.
2. Flow saturation: each edge's load is the number of people routed through
   it; queue_minutes = load / max_flow (max_flow = people per minute).
   An edge is a bottleneck when queue_minutes >= bottleneck_queue_minutes.
3. Betweenness: the share of (occupied node, exit) pairs whose shortest
   path (by route cost) uses the edge, on the graph walking people can use.
4. Single points of failure: a used edge whose loss would leave some people
   with no exit at all (a bridge of their usable graph).
5. Recommendations are sentences built only from the numbers above.

Limits: everyone leaves at once and follows the chosen route; no walking
speeds, crowd behaviour or staff assistance are modelled here (that is the
tick-based simulation of a later build step).
"""

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Sequence

import networkx as nx

from app.services.hazards import HazardContext
from app.services.routing import (
    NO_STAIRS,
    InvalidRouteRequest,
    NoRouteError,
    _value,
    build_graph,
    nearest_safe_exit,
)


@dataclass(frozen=True)
class Group:
    node_id: int
    mobility: str
    kind: str  # "patient" or "staff"
    people: int


def _plural(count: int, word: str) -> str:
    if word == "staff":
        return f"{count} staff"
    return f"{count} {word}{'' if count == 1 else 's'}"


def _describe(group: Group) -> str:
    if group.kind == "staff":
        return _plural(group.people, "staff")
    return f"{group.people} {group.mobility} {'patient' if group.people == 1 else 'patients'}"


def analyse(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    groups: Sequence[Group],
    hazard: HazardContext | None,
    algorithm: str,
    *,
    queue_minutes_threshold: float,
    exit_imbalance_share: float,
) -> dict:
    node_by_id = {node.id: node for node in nodes}
    edge_by_id = {edge.id: edge for edge in edges}

    def name(node_id):
        return node_by_id[node_id].name

    def edge_label(edge_id):
        edge = edge_by_id[edge_id]
        return f"{name(edge.from_node_id)} – {name(edge.to_node_id)}"

    # 1. Route every group.
    routes, unreachable = [], []
    edge_load: dict[int, int] = defaultdict(int)
    edge_groups: dict[int, list[int]] = defaultdict(list)
    exit_load: dict[int, int] = defaultdict(int)
    for index, group in enumerate(groups):
        try:
            result = nearest_safe_exit(nodes, edges, group.node_id, mobility=group.mobility,
                                       algorithm=algorithm, hazard=hazard)
        except (NoRouteError, InvalidRouteRequest) as exc:
            unreachable.append({"group": group, "reason": str(exc)})
            continue
        routes.append({"group": group, "result": result, "index": index})
        exit_load[result.node_ids[-1]] += group.people
        for edge_id in result.edge_ids:
            edge_load[edge_id] += group.people
            edge_groups[edge_id].append(len(routes) - 1)

    # 3. Betweenness on the walking graph.
    walking = build_graph(nodes, edges, "ambulatory", hazard)
    sources = sorted({g.node_id for g in groups if g.node_id in walking})
    exits = sorted(n for n, data in walking.nodes(data=True) if data["type"] == "exit")
    betweenness: dict[int, float] = {}
    pairs = sum(1 for s in sources for t in exits if s != t)
    if sources and exits and pairs:
        raw = nx.edge_betweenness_centrality_subset(
            walking, sources=sources, targets=exits, normalized=False, weight="cost",
        )
        for (u, v), value in raw.items():
            # networkx halves undirected subset values; x2 gives path counts.
            betweenness[walking[u][v]["edge_id"]] = min(1.0, 2 * value / pairs)

    # 4. Single points of failure, per mobility graph.
    cut_off: dict[int, int] = defaultdict(int)
    for mobility in sorted({route["group"].mobility for route in routes}):
        graph = build_graph(nodes, edges, mobility, hazard)
        mobility_groups = [g for g in groups if g.mobility == mobility and g.node_id in graph]
        used = {e for r in routes if r["group"].mobility == mobility for e in r["result"].edge_ids}
        for u, v in nx.bridges(graph):
            edge_id = graph[u][v]["edge_id"]
            if edge_id not in used:
                continue
            reduced = graph.copy()
            reduced.remove_edge(u, v)
            component_of = {}
            for component in nx.connected_components(reduced):
                has_exit = any(reduced.nodes[n]["type"] == "exit" for n in component)
                for n in component:
                    component_of[n] = has_exit
            cut_off[edge_id] += sum(g.people for g in mobility_groups if not component_of[g.node_id])

    # 2. Edge table.
    edge_rows = []
    for edge_id in sorted(set(edge_load) | set(cut_off)):
        edge = edge_by_id[edge_id]
        load = edge_load.get(edge_id, 0)
        queue = load / edge.max_flow
        edge_rows.append({
            "edge_id": edge_id,
            "from_node_id": edge.from_node_id,
            "to_node_id": edge.to_node_id,
            "label": edge_label(edge_id),
            "people": load,
            "max_flow_per_minute": edge.max_flow,
            "queue_minutes": round(queue, 2),
            "betweenness_share": round(betweenness.get(edge_id, 0.0), 4),
            "cut_off_people": cut_off.get(edge_id, 0),
            "is_bottleneck": queue >= queue_minutes_threshold,
        })
    edge_rows.sort(key=lambda r: (-r["queue_minutes"], -r["cut_off_people"], -r["betweenness_share"]))

    total_routed = sum(r["group"].people for r in routes)
    exit_rows = [{
        "node_id": exit_id, "name": name(exit_id), "people": people,
        "share": round(people / total_routed, 4) if total_routed else 0.0,
    } for exit_id, people in sorted(exit_load.items(), key=lambda item: -item[1])]

    # 5. Recommendations.
    recommendations = []

    def recommend(severity, text, node_ids=(), edge_ids=()):
        recommendations.append({"severity": severity, "text": text,
                                "node_ids": list(node_ids), "edge_ids": list(edge_ids)})

    ordinary_lifts = [n for n in nodes if _value(n.type) == "lift" and not n.is_evacuation_lift]
    for item in unreachable:
        group = item["group"]
        advice = "Plan an assisted evacuation for them"
        if hazard and hazard.lifts_disabled and group.mobility in NO_STAIRS and ordinary_lifts:
            advice += ", or mark a protected lift as an evacuation lift"
        recommend("critical",
                  f"{_describe(group)} at {name(group.node_id)} have no safe route "
                  f"({item['reason'].rstrip('.')}). {advice}.",
                  node_ids=[group.node_id])

    for row in edge_rows:
        if not row["is_bottleneck"]:
            continue
        text = (f"{row['label']} carries {row['people']} people; at {row['max_flow_per_minute']} "
                f"people per minute they need about {row['queue_minutes']:.1f} minutes to pass.")
        biggest = max((routes[i] for i in edge_groups[row["edge_id"]]),
                      key=lambda r: r["group"].people)
        group = biggest["group"]
        try:
            alternative = nearest_safe_exit(
                nodes, edges, group.node_id, mobility=group.mobility, algorithm=algorithm,
                hazard=hazard, excluded_edge_ids=frozenset({row["edge_id"]}),
            )
            extra = alternative.distance_metres - biggest["result"].distance_metres
            text += (f" The {_describe(group)} from {name(group.node_id)} could use exit "
                     f"{name(alternative.node_ids[-1])} instead ({extra:+.0f} m).")
        except (NoRouteError, InvalidRouteRequest):
            text += (f" The {_describe(group)} from {name(group.node_id)} have no other route; "
                     "consider staggered departure or adding a second route.")
        recommend("warning", text, edge_ids=[row["edge_id"]])

    for row in edge_rows:
        if row["cut_off_people"]:
            recommend("warning",
                      f"If {row['label']} becomes blocked, {row['cut_off_people']} people would have "
                      "no exit. Keep it clear and plan a second way out.",
                      edge_ids=[row["edge_id"]])

    if len(exits) >= 2 and exit_rows and exit_rows[0]["share"] > exit_imbalance_share:
        busiest = exit_rows[0]
        others = [name(e) for e in exits if e != busiest["node_id"]]
        recommend("info",
                  f"Exit {busiest['name']} receives {busiest['share']:.0%} of evacuees "
                  f"({busiest['people']} of {total_routed}). Consider directing some groups to "
                  f"{', '.join(others)}.",
                  node_ids=[busiest["node_id"]])

    if hazard and hazard.lifts_disabled and any(_value(n.type) == "lift" for n in nodes):
        evacuation_lifts = [n.name for n in nodes if _value(n.type) == "lift" and n.is_evacuation_lift]
        recommend("info",
                  "Ordinary lifts are not used because of fire or smoke. "
                  + (f"Evacuation lifts in use: {', '.join(evacuation_lifts)}."
                     if evacuation_lifts else "No lift is marked as an evacuation lift."))

    if not recommendations:
        recommend("info", "No bottlenecks or unreachable people found with the current parameters.")

    return {
        "people": {
            "total": sum(g.people for g in groups),
            "routed": total_routed,
            "unreachable": sum(item["group"].people for item in unreachable),
        },
        "routes": [{
            "start_node_id": r["group"].node_id,
            "start_name": name(r["group"].node_id),
            "mobility": r["group"].mobility,
            "kind": r["group"].kind,
            "people": r["group"].people,
            "exit_node_id": r["result"].node_ids[-1],
            "exit_name": r["result"].node_names[-1],
            "node_ids": r["result"].node_ids,
            "node_names": r["result"].node_names,
            "distance_metres": r["result"].distance_metres,
            "risk_cost_metres": r["result"].risk_cost_metres,
        } for r in routes],
        "unreachable": [{
            "node_id": item["group"].node_id,
            "name": name(item["group"].node_id),
            "mobility": item["group"].mobility,
            "kind": item["group"].kind,
            "people": item["group"].people,
            "reason": item["reason"],
        } for item in unreachable],
        "edges": edge_rows,
        "bottleneck_edge_ids": [r["edge_id"] for r in edge_rows if r["is_bottleneck"]],
        "exits": exit_rows,
        "recommendations": recommendations,
    }
