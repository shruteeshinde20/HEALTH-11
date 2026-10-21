"""Hazard spread and per-node risk (PROJECT.md: hazards spread over time and
block nodes and edges; risk score per node added as extra cost in routing).

Model (algorithmic, not machine learning):
- A hazard starts at its origin node and spreads along the building graph at
  `spread_rate` metres per minute. A node is reached at
  arrival = (shortest graph distance from the origin) / spread_rate.
  This is a graph cellular automaton in continuous time: a node ignites when
  the front from a burning neighbour reaches it. spread_rate 0 = origin only.
- Spread follows corridors, stairs and lifts regardless of accessibility
  flags or blocked doors (the model does not know about fire doors).
- Reached nodes: fire, hazmat and structural hazards block them; smoke blocks
  them at or above `smoke_blocking_severity`, otherwise adds risk.
- Risk 0-1: severity/5 once reached; before that it rises linearly over the
  `hazard_risk_horizon_minutes` before arrival. Several hazards: maximum.
- During any fire or smoke hazard, ordinary lifts are not used; only lifts
  marked as evacuation lifts remain usable.
- A hazard may start later (optional `start_minutes`, used for hazards added
  during a simulation): before it starts it has no effect; afterwards its
  arrival times are counted from its start.

Limits: no ventilation, temperature, door or material data; spread speed is
whatever the scenario says. Results support planning and training only.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

import networkx as nx

BLOCKING_TYPES = frozenset({"fire", "hazmat", "structural"})
LIFT_DISABLING_TYPES = frozenset({"fire", "smoke"})


def _value(value: Any) -> str:
    return str(getattr(value, "value", value)).lower()


@dataclass(frozen=True)
class NodeHazard:
    risk: float
    blocked: bool
    arrival_minutes: float | None  # earliest arrival of any hazard; None = never
    reached_types: tuple[str, ...] = ()  # hazard types already here (for drawing)


@dataclass
class HazardContext:
    """Everything routing needs to know about hazards at one moment."""

    minutes_elapsed: float = 0.0
    nodes: dict[int, NodeHazard] = field(default_factory=dict)
    lifts_disabled: bool = False
    risk_cost_metres: float = 0.0
    ignored_hazard_ids: list[int] = field(default_factory=list)

    @property
    def blocked_ids(self) -> frozenset[int]:
        return frozenset(n for n, state in self.nodes.items() if state.blocked)

    def risk(self, node_id: int) -> float:
        state = self.nodes.get(node_id)
        return state.risk if state else 0.0


def hazard_context(
    nodes: Sequence[Any],
    edges: Sequence[Any],
    hazards: Sequence[Any],
    minutes_elapsed: float,
    *,
    horizon_minutes: float,
    risk_cost_metres: float,
    smoke_blocking_severity: float,
) -> HazardContext:
    graph = nx.Graph()
    graph.add_nodes_from(node.id for node in nodes)
    for edge in edges:
        if edge.from_node_id in graph and edge.to_node_id in graph:
            graph.add_edge(edge.from_node_id, edge.to_node_id, distance=float(edge.distance))

    context = HazardContext(minutes_elapsed=minutes_elapsed, risk_cost_metres=risk_cost_metres)
    risk: dict[int, float] = {}
    blocked: set[int] = set()
    arrival: dict[int, float] = {}
    reached: dict[int, set[str]] = {}

    for hazard in hazards:
        if not getattr(hazard, "is_active", True):
            continue
        if hazard.origin_node_id not in graph:
            context.ignored_hazard_ids.append(hazard.id)
            continue
        start = float(getattr(hazard, "start_minutes", 0.0) or 0.0)
        if start > minutes_elapsed:
            continue
        kind = _value(hazard.type)
        if kind in LIFT_DISABLING_TYPES:
            context.lifts_disabled = True
        intensity = min(max(hazard.severity / 5.0, 0.0), 1.0)
        blocks = kind in BLOCKING_TYPES or (
            kind == "smoke" and hazard.severity >= smoke_blocking_severity
        )
        distances = nx.single_source_dijkstra_path_length(graph, hazard.origin_node_id, weight="distance")
        for node_id, metres in distances.items():
            if hazard.spread_rate > 0:
                reached_at = start + metres / hazard.spread_rate
            else:
                reached_at = start if node_id == hazard.origin_node_id else math.inf
            if not math.isfinite(reached_at):
                continue
            arrival[node_id] = min(arrival.get(node_id, math.inf), reached_at)
            if reached_at <= minutes_elapsed:
                node_risk = intensity
                reached.setdefault(node_id, set()).add(kind)
                if blocks:
                    blocked.add(node_id)
            elif reached_at - minutes_elapsed <= horizon_minutes:
                node_risk = intensity * (1 - (reached_at - minutes_elapsed) / horizon_minutes)
            else:
                node_risk = 0.0
            risk[node_id] = max(risk.get(node_id, 0.0), node_risk)

    for node_id in set(risk) | blocked | set(arrival):
        context.nodes[node_id] = NodeHazard(
            risk=round(risk.get(node_id, 0.0), 6),
            blocked=node_id in blocked,
            arrival_minutes=arrival.get(node_id),
            reached_types=tuple(sorted(reached.get(node_id, ()))),
        )
    return context
