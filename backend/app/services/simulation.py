"""Tick-based evacuation simulation (PROJECT.md build step 9).

Deterministic: the same inputs always give the same result.

Model
- Every placed patient and staff member is one person ("agent"). Staff are
  ambulatory. Each agent follows the chosen algorithm's route to the nearest
  safe exit (app.services.routing) at the speed for its mobility type.
- Congestion: an edge lets at most `max_flow` people per minute enter it
  (shared by both directions). Others wait at the node in arrival order
  (first come, first served). Agents on an edge move at their own speed.
- Hazards spread on the simulation clock (app.services.hazards). When the
  set of unusable nodes changes (a node is reached, or lifts are switched
  off by fire or smoke), agents whose remaining route uses such a node
  re-route. An agent in a corridor continues or turns back, whichever gives
  the shorter safe way out.
- Outcomes: "evacuated" (reached an exit), "needs_assistance" (no safe
  route), "reached_by_hazard" (the hazard reached the node they were on, or
  the node they were walking to). Nobody counts as evacuated unless they
  reached an exit.

- Crowd model (on when ModelSettings.crowd_model is true; the website's
  default, parameter crowd_model_enabled). It uses the SFPE hydraulic
  relations as restated in NIST Technical Note 1722:
  * effective width = path width minus a boundary layer on each side;
  * a path lets in at most k / (4a) people per second per metre of
    effective width (about 1.32 on level floors, 1.02 on stairs), so a wide
    corridor admits several people at once; its max_flow still caps this;
  * walking speed falls with density D (people per m2 on the path):
    v = v_free * (1 - aD) / (1 - a * 0.54) above 0.54 people/m2, never below
    min_speed_fraction of v_free; a = 0.266;
  * a path holds at most max_density_per_m2 * length * effective width people;
  * on a flight of stairs (a path between two stair places) people move at
    k_stairs / k_level = 1.08 / 1.40 of their level speed;
  * people walk side by side in lanes across the effective width (positions).
  With the crowd model off, the model above the list is used unchanged.

Limits: no overtaking within a lane, no node capacity limits, no staff
helping patients, no pre-movement (alarm) delay. One tick moves each agent at
most one edge end.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from app.services.hazards import HazardContext, hazard_context
from app.services.routing import (
    InvalidRouteRequest,
    NoRouteError,
    RouteResult,
    _value,
    nearest_safe_exit,
)

ACTIVE = "active"
EVACUATED = "evacuated"
NEEDS_ASSISTANCE = "needs_assistance"
REACHED_BY_HAZARD = "reached_by_hazard"
MAX_AGENTS = 5000
EPSILON = 1e-9  # absorbs floating-point rounding when adding up steps
STRANDED_REASON = "No safe route from here. Plan an assisted evacuation"

# SFPE hydraulic model constants (NIST TN 1722): speed S = k (1 - a D).
SFPE_A = 0.266
SFPE_K_LEVEL = 1.40
SFPE_K_STAIRS = 1.08
FREE_FLOW_DENSITY = 0.54   # people/m2; below this people walk at their free speed
MIN_EFFECTIVE_WIDTH_M = 0.3
LANE_WIDTH_M = 0.6         # one person's shoulder width, for drawing lanes only


@dataclass
class Agent:
    id: str
    kind: str
    mobility: str
    speed: float
    start_node_id: int
    order: int
    status: str = ACTIVE
    path: list[int] = field(default_factory=list)  # nodes still to visit; path[0] = current/last node
    on_edge: bool = False
    edge_id: int | None = None
    edge_length: float = 0.0
    progress: float = 0.0
    queued_at: float = 0.0
    distance: float = 0.0
    wait: float = 0.0
    risk_exposure: float = 0.0
    reroutes: int = 0
    evacuated_at: float | None = None
    exit_node_id: int | None = None
    outcome_reason: str | None = None
    initial_route: list[int] = field(default_factory=list)


@dataclass
class ModelSettings:
    speeds: dict[str, float]
    tick_seconds: float
    max_seconds: float
    horizon_minutes: float
    risk_cost_metres: float
    smoke_blocking_severity: float
    crowd_model: bool = False
    boundary_layer_m: float = 0.15
    max_density_per_m2: float = 3.55
    min_speed_fraction: float = 0.15


class Simulation:
    def __init__(
        self,
        nodes: Sequence[Any],
        edges: Sequence[Any],
        agents: Sequence[Any],
        hazards: Sequence[Any],
        algorithm: str,
        settings: ModelSettings,
    ):
        if len(agents) > MAX_AGENTS:
            raise ValueError(f"At most {MAX_AGENTS} people can be simulated at once")
        self.nodes = list(nodes)
        self.edges = list(edges)
        self.hazards = list(hazards)
        self.algorithm = algorithm
        self.settings = settings
        self.t = 0.0
        self.done = False
        self.timed_out = False

        self.node_by_id = {node.id: node for node in self.nodes}
        self.edge_by_id = {edge.id: edge for edge in self.edges}
        self.edge_by_pair = {frozenset((e.from_node_id, e.to_node_id)): e for e in self.edges}
        self.ordinary_lifts = frozenset(
            n.id for n in self.nodes
            if _value(n.type) == "lift" and not getattr(n, "is_evacuation_lift", False)
        )

        self.queues: dict[int, list[Agent]] = {}
        stair_ids = {n.id for n in self.nodes if _value(n.type) == "stair"}
        self.stair_edges = frozenset(
            e.id for e in self.edges if e.from_node_id in stair_ids and e.to_node_id in stair_ids)
        # People per second that may enter each path, and how many it holds.
        self.flow_rate: dict[int, float] = {edge.id: self._flow_rate(edge) for edge in self.edges}
        self.max_occupancy: dict[int, int | None] = {edge.id: self._max_occupancy(edge) for edge in self.edges}
        self.on_edge_count: dict[int, int] = {edge.id: 0 for edge in self.edges}
        # Each corridor starts with a full allowance, so the first person
        # walks straight into an empty corridor.
        self.allowance: dict[int, float] = {
            edge.id: max(1.0, self.flow_rate[edge.id] * settings.tick_seconds) for edge in self.edges
        }
        self.edge_stats = {edge.id: {"people": 0, "wait": 0.0, "max_queue": 0, "max_wait": 0.0}
                           for edge in self.edges}
        self.events: list[dict] = []
        self._route_cache: dict[tuple, RouteResult | str] = {}
        self._hazard_version = 0
        self.hazard: HazardContext | None = None
        self._unusable: frozenset[int] = frozenset()
        self._next_event = 0.0
        self._refresh_hazard()

        self.agents = [
            Agent(id=a.id, kind=a.kind, mobility=a.mobility,
                  speed=settings.speeds[a.mobility], start_node_id=a.node_id, order=i)
            for i, a in enumerate(agents)
        ]
        for agent in self.agents:
            self._start(agent)

    # --- crowd model -----------------------------------------------------------

    def effective_width(self, edge: Any) -> float:
        width = float(getattr(edge, "width", 0.0) or 0.0)
        return max(width - 2 * self.settings.boundary_layer_m, MIN_EFFECTIVE_WIDTH_M)

    def _flow_rate(self, edge: Any) -> float:
        configured = edge.max_flow / 60.0
        if not self.settings.crowd_model:
            return configured
        k = SFPE_K_STAIRS if edge.id in self.stair_edges else SFPE_K_LEVEL
        return min(configured, k / (4 * SFPE_A) * self.effective_width(edge))

    def _max_occupancy(self, edge: Any) -> int | None:
        if not self.settings.crowd_model or float(edge.distance) <= 0:
            return None
        area = float(edge.distance) * self.effective_width(edge)
        return max(1, math.floor(self.settings.max_density_per_m2 * area + EPSILON))

    def speed_factor(self, edge: Any, people_on_edge: int) -> float:
        """Share of free walking speed on this path with this many people on it."""
        if not self.settings.crowd_model:
            return 1.0
        factor = 1.0
        length = float(edge.distance)
        if length > 0 and people_on_edge > 0:
            density = people_on_edge / (length * self.effective_width(edge))
            if density > FREE_FLOW_DENSITY:
                factor = (1 - SFPE_A * density) / (1 - SFPE_A * FREE_FLOW_DENSITY)
        factor = max(factor, self.settings.min_speed_fraction)
        if edge.id in self.stair_edges:
            factor *= SFPE_K_STAIRS / SFPE_K_LEVEL
        return factor

    # --- hazards ------------------------------------------------------------

    def add_hazard(self, hazard: Any) -> None:
        """Add a hazard during the run (dynamic re-routing)."""
        self.hazards.append(hazard)
        self._next_event = self.t  # re-evaluate at the start of the next tick

    def _refresh_hazard(self) -> set[int]:
        minutes = self.t / 60.0
        context = hazard_context(
            self.nodes, self.edges, self.hazards, minutes,
            horizon_minutes=self.settings.horizon_minutes,
            risk_cost_metres=self.settings.risk_cost_metres,
            smoke_blocking_severity=self.settings.smoke_blocking_severity,
        )
        unusable = set(context.blocked_ids)
        if context.lifts_disabled:
            unusable |= self.ordinary_lifts
        newly = unusable - self._unusable
        if newly or self.hazard is None or context.lifts_disabled != self.hazard.lifts_disabled:
            self._hazard_version += 1
            self._route_cache.clear()
        if newly:
            self.events.append({"t": self.t, "unusable_node_ids": sorted(newly)})
        self.hazard = context
        self._unusable = frozenset(unusable)

        # Next moment something changes: a hazard arrives somewhere or starts.
        upcoming = [
            state.arrival_minutes * 60 for state in context.nodes.values()
            if state.arrival_minutes is not None and state.arrival_minutes * 60 > self.t
        ]
        upcoming += [
            float(getattr(h, "start_minutes", 0.0) or 0.0) * 60 for h in self.hazards
            if float(getattr(h, "start_minutes", 0.0) or 0.0) * 60 > self.t
        ]
        self._next_event = min(upcoming, default=math.inf)
        return newly

    # --- routing ------------------------------------------------------------

    def _route(self, node_id: int, mobility: str) -> RouteResult | str:
        key = (node_id, mobility, self._hazard_version)
        if key not in self._route_cache:
            try:
                self._route_cache[key] = nearest_safe_exit(
                    self.nodes, self.edges, node_id, mobility=mobility,
                    algorithm=self.algorithm, hazard=self.hazard,
                )
            except (NoRouteError, InvalidRouteRequest) as exc:
                self._route_cache[key] = str(exc)
        return self._route_cache[key]

    def _finish(self, agent: Agent, status: str, reason: str | None = None) -> None:
        agent.status = status
        agent.on_edge = False
        agent.outcome_reason = reason
        if status == EVACUATED:
            agent.evacuated_at = self.t
            agent.exit_node_id = agent.path[0]

    def _enqueue(self, agent: Agent, queued_at: float) -> None:
        if len(agent.path) == 1:
            if _value(self.node_by_id[agent.path[0]].type) == "exit":
                self._finish(agent, EVACUATED)
            else:
                self._finish(agent, NEEDS_ASSISTANCE, STRANDED_REASON)
            return
        edge = self.edge_by_pair[frozenset(agent.path[:2])]
        agent.edge_id = edge.id
        agent.queued_at = queued_at
        self.queues.setdefault(edge.id, []).append(agent)

    def _start(self, agent: Agent) -> None:
        if agent.start_node_id in self._unusable:
            self._finish(agent, REACHED_BY_HAZARD, "The hazard had already reached this location")
            agent.path = [agent.start_node_id]
            return
        route = self._route(agent.start_node_id, agent.mobility)
        agent.path = [agent.start_node_id]
        if isinstance(route, str):
            self._finish(agent, NEEDS_ASSISTANCE, route)
            return
        agent.path = list(route.node_ids)
        agent.initial_route = list(route.node_ids)
        self._enqueue(agent, 0.0)

    def _dequeue(self, agent: Agent) -> None:
        queue = self.queues.get(agent.edge_id, [])
        if agent in queue:
            queue.remove(agent)

    def _reroute(self, agent: Agent) -> None:
        agent.reroutes += 1
        if not agent.on_edge:
            self._dequeue(agent)
            route = self._route(agent.path[0], agent.mobility)
            if isinstance(route, str):
                agent.path = agent.path[:1]
                self._finish(agent, NEEDS_ASSISTANCE, route)
                return
            agent.path = list(route.node_ids)
            self._enqueue(agent, agent.queued_at)
            return

        # In a corridor: go on to the next node or turn back, whichever is safer.
        here, ahead = agent.path[0], agent.path[1]
        options = []
        for node_id, remaining, turn_back in (
            (ahead, agent.edge_length - agent.progress, False),
            (here, agent.progress, True),
        ):
            if node_id in self._unusable:
                continue
            route = self._route(node_id, agent.mobility)
            if isinstance(route, str):
                continue
            total = remaining + route.distance_metres + route.risk_cost_metres
            options.append((total, turn_back, route))
        if not options:
            # No safe way out: go back to the last safe node (or, if that is
            # gone too, on to the next one) and wait there for assistance.
            if here not in self._unusable:
                agent.progress = agent.edge_length - agent.progress
                agent.path = [ahead, here]
            else:
                agent.path = [here, ahead]
            agent.outcome_reason = "stranded"
            return
        _, turn_back, route = min(options, key=lambda o: (o[0], o[1]))
        if turn_back:
            agent.progress = agent.edge_length - agent.progress
            agent.path = [ahead] + list(route.node_ids)
        else:
            agent.path = [here] + list(route.node_ids)

    # --- stepping -------------------------------------------------------------

    def _apply_hazard_changes(self) -> None:
        if self.t < self._next_event:
            return
        self._refresh_hazard()
        for agent in self.agents:
            if agent.status != ACTIVE:
                continue
            if not agent.on_edge and agent.path[0] in self._unusable:
                self._dequeue(agent)
                agent.path = agent.path[:1]
                self._finish(agent, REACHED_BY_HAZARD, "The hazard reached this location")
            elif any(n in self._unusable for n in agent.path[1:]):
                self._reroute(agent)

    def _admit(self) -> None:
        """Let waiting people into corridors, first come first served."""
        dt = self.settings.tick_seconds
        for edge in self.edges:
            rate = self.flow_rate[edge.id] * dt
            queue = self.queues.get(edge.id)
            cap = max(1.0, rate)
            if self.settings.crowd_model and queue:
                # Keep the unused part of a person while people are waiting, so a
                # rate of 0.79 or 2.76 people per second is kept on average.
                left = self.allowance[edge.id]
                cap += left - math.floor(left + EPSILON)
            self.allowance[edge.id] = min(self.allowance[edge.id] + rate, cap)
            if not queue:
                continue
            queue.sort(key=lambda a: (a.queued_at, a.order))
            stats = self.edge_stats[edge.id]
            stats["max_queue"] = max(stats["max_queue"], len(queue))
            limit = self.max_occupancy[edge.id]
            while queue and self.allowance[edge.id] >= 1.0 - EPSILON and queue[0].queued_at <= self.t \
                    and (limit is None or self.on_edge_count[edge.id] < limit):
                agent = queue.pop(0)
                self.on_edge_count[edge.id] += 1
                self.allowance[edge.id] -= 1.0
                waited = self.t - agent.queued_at
                agent.wait += waited
                stats["wait"] += waited
                stats["max_wait"] = max(stats["max_wait"], waited)
                stats["people"] += 1
                agent.on_edge = True
                agent.edge_length = float(edge.distance)
                agent.progress = 0.0

    def step(self) -> dict:
        """Advance one tick (admit, move, arrive) and return the new frame."""
        if self.done:
            return self.frame()
        dt = self.settings.tick_seconds
        self._apply_hazard_changes()
        self._admit()

        crowd = dict(self.on_edge_count)  # people on each path at the start of this tick
        for agent in self.agents:
            if agent.status != ACTIVE:
                continue
            if agent.on_edge:
                speed = agent.speed * self.speed_factor(self.edge_by_id[agent.edge_id], crowd[agent.edge_id])
                move = min(speed * dt, max(agent.edge_length - agent.progress, 0.0))
                agent.progress += speed * dt
                agent.distance += move
                agent.risk_exposure += dt * max(self.hazard.risk(agent.path[0]),
                                                self.hazard.risk(agent.path[1]))
            else:
                agent.risk_exposure += dt * self.hazard.risk(agent.path[0])

        self.t = round(self.t + dt, 9)
        for agent in self.agents:
            if agent.status != ACTIVE or not agent.on_edge or agent.progress < agent.edge_length - EPSILON:
                continue
            self.on_edge_count[agent.edge_id] -= 1
            agent.on_edge = False
            agent.path = agent.path[1:]
            node_id = agent.path[0]
            if node_id in self._unusable:
                self._finish(agent, REACHED_BY_HAZARD, "The hazard reached this location")
            elif agent.outcome_reason == "stranded" and len(agent.path) == 1 \
                    and _value(self.node_by_id[node_id].type) != "exit":
                self._finish(agent, NEEDS_ASSISTANCE, STRANDED_REASON)
            else:
                self._enqueue(agent, self.t)

        if not any(a.status == ACTIVE for a in self.agents):
            self.done = True
        elif self.t >= self.settings.max_seconds - 1e-9:
            self.done = True
            self.timed_out = True
        return self.frame()

    def run_to_end(self, frame_seconds: float | None = None) -> list[dict]:
        """Run until everyone is out, stuck or time is up.

        Returns a timeline sampled every `frame_seconds` (counts, blocked
        nodes and congested edges, without positions), plus the final frame.
        """
        timeline = [self.frame(positions=False)]
        next_sample = frame_seconds or math.inf
        while not self.done:
            frame = self.step()
            if self.t + 1e-9 >= next_sample or self.done:
                timeline.append({k: v for k, v in frame.items() if k not in ("positions", "hazards")})
                while next_sample <= self.t + 1e-9:
                    next_sample += frame_seconds or math.inf
        return timeline

    # --- output -----------------------------------------------------------------

    def _position(self, agent: Agent) -> dict:
        here = self.node_by_id[agent.path[0]]
        x, y, floor_id = here.x, here.y, here.floor_id
        if agent.on_edge and len(agent.path) > 1:
            ahead = self.node_by_id[agent.path[1]]
            share = 1.0 if agent.edge_length <= 0 else min(agent.progress / agent.edge_length, 1.0)
            x = here.x + (ahead.x - here.x) * share
            y = here.y + (ahead.y - here.y) * share
            if self.settings.crowd_model and agent.edge_id is not None:
                # Side by side: spread people over lanes across the usable width.
                width = self.effective_width(self.edge_by_id[agent.edge_id])
                lanes = max(1, math.floor(width / LANE_WIDTH_M))
                dx, dy = ahead.x - here.x, ahead.y - here.y
                norm = math.hypot(dx, dy)
                if lanes > 1 and norm > 0:
                    offset = ((agent.order % lanes) - (lanes - 1) / 2) * (width / lanes)
                    x += -dy / norm * offset
                    y += dx / norm * offset
            floor_id = ahead.floor_id if share >= 0.5 else here.floor_id
        return {"id": agent.id, "x": round(x, 3), "y": round(y, 3), "floor_id": floor_id,
                "mobility": agent.mobility, "status": agent.status}

    def counts(self) -> dict:
        tally = {ACTIVE: 0, EVACUATED: 0, NEEDS_ASSISTANCE: 0, REACHED_BY_HAZARD: 0}
        for agent in self.agents:
            tally[agent.status] += 1
        return tally

    def exit_load(self) -> dict[str, int]:
        load: dict[str, int] = {}
        for agent in self.agents:
            if agent.status == EVACUATED:
                key = str(agent.exit_node_id)
                load[key] = load.get(key, 0) + 1
        return load

    def frame(self, positions: bool = True) -> dict:
        tally = self.counts()
        frame = {
            "t": self.t,
            "total": len(self.agents),
            "evacuated": tally[EVACUATED],
            "active": tally[ACTIVE],
            "needs_assistance": tally[NEEDS_ASSISTANCE],
            "reached_by_hazard": tally[REACHED_BY_HAZARD],
            "blocked_nodes": sorted(self._unusable),
            "congested_edges": sorted(
                edge_id for edge_id, queue in self.queues.items()
                if any(a.queued_at <= self.t for a in queue)
            ),
            "exit_load": self.exit_load(),
            "done": self.done,
        }
        if positions:
            frame["positions"] = [self._position(a) for a in self.agents
                                  if a.status != EVACUATED]
            frame["hazards"] = self.hazard_rows()
        return frame

    def hazard_rows(self) -> list[dict]:
        """Where hazards are now, for drawing: places a hazard has reached
        (with its types) and places it is about to reach (risk above 0)."""
        if self.hazard is None:
            return []
        return [
            {"node_id": node_id, "types": list(state.reached_types),
             "reached": bool(state.reached_types), "risk": round(state.risk, 3)}
            for node_id, state in sorted(self.hazard.nodes.items())
            if state.reached_types or state.risk > 0
        ]

    def summary(self) -> dict:
        tally = self.counts()
        evacuated = [a for a in self.agents if a.status == EVACUATED]
        times = [a.evacuated_at for a in evacuated]
        everyone = len(evacuated) == len(self.agents)
        return {
            "total": len(self.agents),
            "evacuated": tally[EVACUATED],
            "needs_assistance": tally[NEEDS_ASSISTANCE],
            "reached_by_hazard": tally[REACHED_BY_HAZARD],
            "still_moving": tally[ACTIVE],
            "all_evacuated": everyone and bool(self.agents),
            "evacuation_time_s": max(times) if times else None,
            "simulated_seconds": self.t,
            "timed_out": self.timed_out,
            "mean_distance_m": round(sum(a.distance for a in evacuated) / len(evacuated), 3)
            if evacuated else None,
            "max_distance_m": round(max(a.distance for a in evacuated), 3) if evacuated else None,
            "mean_wait_s": round(sum(a.wait for a in self.agents) / len(self.agents), 3)
            if self.agents else None,
            "mean_risk_exposure": round(sum(a.risk_exposure for a in self.agents) / len(self.agents), 4)
            if self.agents else None,
            "reroutes": sum(a.reroutes for a in self.agents),
        }

    def agent_rows(self) -> list[dict]:
        return [{
            "id": a.id, "kind": a.kind, "mobility": a.mobility,
            "start_node_id": a.start_node_id, "status": a.status,
            "exit_node_id": a.exit_node_id, "evacuated_at_s": a.evacuated_at,
            "distance_m": round(a.distance, 3), "wait_s": round(a.wait, 3),
            "risk_exposure": round(a.risk_exposure, 4), "reroutes": a.reroutes,
            "initial_route": a.initial_route, "reason": a.outcome_reason
            if a.outcome_reason != "stranded" else None,
        } for a in self.agents]

    def congestion_rows(self) -> list[dict]:
        rows = []
        for edge_id, stats in self.edge_stats.items():
            if not stats["people"] and not stats["max_queue"]:
                continue
            edge = self.edge_by_id[edge_id]
            rows.append({
                "edge_id": edge_id,
                "label": f"{self.node_by_id[edge.from_node_id].name} – "
                         f"{self.node_by_id[edge.to_node_id].name}",
                "people": stats["people"],
                "max_queue": stats["max_queue"],
                "total_wait_s": round(stats["wait"], 3),
                "max_wait_s": round(stats["max_wait"], 3),
            })
        rows.sort(key=lambda r: (-r["total_wait_s"], -r["people"], r["edge_id"]))
        return rows
