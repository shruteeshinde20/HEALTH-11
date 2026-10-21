"""Glue between the database and the simulation engine.

A run stores a snapshot of everything it used (building graph, people,
hazards, parameters), so it can be replayed exactly later even if the
floor plan changes.
"""

from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.facility import Floor
from app.models.graph import Node
from app.models.operations import Patient, Staff
from app.services import bottlenecks
from app.services.hazards import hazard_context
from app.services.model_parameters import load_parameters
from app.services.scenario_inputs import building_nodes_and_edges, scenario_hazards
from app.services.simulation import MAX_AGENTS, ModelSettings, Simulation

MOBILITIES = ("ambulatory", "wheelchair", "stretcher", "ventilator")
PARAMETERS = [
    "speed_ambulatory_m_per_s", "speed_wheelchair_m_per_s", "speed_stretcher_m_per_s",
    "speed_ventilator_m_per_s", "simulation_tick_seconds", "simulation_max_minutes",
    "simulation_frame_seconds", "hazard_risk_horizon_minutes", "hazard_risk_cost_metres",
    "smoke_blocking_severity", "bottleneck_queue_minutes", "exit_imbalance_share",
]

METHOD = [
    "Tick-based simulation: every placed patient and staff member walks the chosen "
    "algorithm's route to the nearest safe exit at the speed for their mobility type. "
    "Deterministic: the same inputs give the same result. Not machine learning.",
    "Congestion: each corridor (edge) lets at most max_flow people per minute in; others "
    "wait in arrival order.",
    "Hazards spread on the simulation clock. When a node on someone's route becomes "
    "unusable they re-route; in a corridor they continue or turn back, whichever is safer.",
    "Outcomes: evacuated (reached an exit), needs_assistance (no safe route), "
    "reached_by_hazard. Nobody counts as evacuated without reaching an exit.",
    "Limits: no pre-movement delay, crowd density or overtaking in corridors, node "
    "capacity, slower stair speeds or staff helping patients. Speeds and other numbers are "
    "listed under parameters_used with their source. For planning and training only; "
    "this does not replace official emergency procedures or fire-safety professionals.",
]


# --- snapshot -------------------------------------------------------------------------

def _node_dict(node):
    return {"id": node.id, "name": node.name, "type": node.type.value, "x": node.x,
            "y": node.y, "floor_id": node.floor_id, "is_blocked": node.is_blocked,
            "is_evacuation_lift": node.is_evacuation_lift,
            "width_m": node.width_m, "length_m": node.length_m}


def _edge_dict(edge):
    return {"id": edge.id, "from_node_id": edge.from_node_id, "to_node_id": edge.to_node_id,
            "distance": edge.distance, "width": edge.width, "max_flow": edge.max_flow,
            "wheelchair_accessible": edge.wheelchair_accessible,
            "stretcher_accessible": edge.stretcher_accessible, "is_blocked": edge.is_blocked}


def _hazard_dict(hazard, start_minutes=0.0):
    return {"id": hazard.id, "name": hazard.name, "type": getattr(hazard.type, "value", hazard.type),
            "origin_node_id": hazard.origin_node_id, "spread_rate": hazard.spread_rate,
            "severity": hazard.severity, "is_active": hazard.is_active,
            "start_minutes": start_minutes}


def building_for_scenario(db: Session, organization_id: int, scenario_id: int) -> int:
    origins = [h.origin_node_id for h in scenario_hazards(db, scenario_id, organization_id)]
    buildings = set()
    if origins:
        buildings = set(db.scalars(
            select(Floor.building_id).join(Node, Node.floor_id == Floor.id).where(
                Node.id.in_(origins), Node.organization_id == organization_id,
            )
        ))
    if len(buildings) == 1:
        return buildings.pop()
    if not buildings:
        raise HTTPException(status_code=422,
                            detail="building_id is required when the scenario has no hazards")
    raise HTTPException(status_code=422,
                        detail="The scenario's hazards are in several buildings; give building_id")


def take_snapshot(db: Session, organization_id: int, scenario_id: int, building_id: int) -> dict:
    nodes, edges = building_nodes_and_edges(db, building_id, organization_id)
    node_ids = [n.id for n in nodes]
    agents = []
    if node_ids:
        for patient in db.scalars(select(Patient).where(
                Patient.organization_id == organization_id, Patient.node_id.in_(node_ids),
                Patient.deleted_at.is_(None)).order_by(Patient.id)):
            agents.append({"id": f"patient-{patient.id}", "kind": "patient",
                           "mobility": patient.mobility.value, "node_id": patient.node_id})
        for member in db.scalars(select(Staff).where(
                Staff.organization_id == organization_id, Staff.node_id.in_(node_ids),
                Staff.deleted_at.is_(None)).order_by(Staff.id)):
            agents.append({"id": f"staff-{member.id}", "kind": "staff",
                           "mobility": "ambulatory", "node_id": member.node_id})
    if len(agents) > MAX_AGENTS:
        raise HTTPException(status_code=422,
                            detail=f"At most {MAX_AGENTS} people can be simulated at once")
    return {
        "building_id": building_id,
        "nodes": [_node_dict(n) for n in nodes],
        "edges": [_edge_dict(e) for e in edges],
        "agents": agents,
        "hazards": [_hazard_dict(h) for h in scenario_hazards(db, scenario_id, organization_id)],
    }


def parameters(db: Session, organization_id: int) -> dict:
    return load_parameters(db, organization_id, PARAMETERS)


def parameters_used(params: dict) -> list[dict]:
    return [{"name": p.name, "value": p.value, "unit": p.unit, "source": p.source,
             "meaning": p.meaning} for p in params.values()]


# --- running ----------------------------------------------------------------------------

def _namespaces(rows):
    return [SimpleNamespace(**row) for row in rows]


def settings_from(values: dict[str, float]) -> ModelSettings:
    return ModelSettings(
        speeds={m: values[f"speed_{m}_m_per_s"] for m in MOBILITIES},
        tick_seconds=values["simulation_tick_seconds"],
        max_seconds=values["simulation_max_minutes"] * 60,
        horizon_minutes=values["hazard_risk_horizon_minutes"],
        risk_cost_metres=values["hazard_risk_cost_metres"],
        smoke_blocking_severity=values["smoke_blocking_severity"],
    )


def build_simulation(snapshot: dict, injected: list[dict], algorithm: str, values: dict) -> Simulation:
    return Simulation(
        _namespaces(snapshot["nodes"]),
        _namespaces(snapshot["edges"]),
        _namespaces(snapshot["agents"]),
        _namespaces(snapshot["hazards"] + injected),
        algorithm,
        settings_from(values),
    )


def _plain_people(count: int) -> str:
    return f"{count} {'person' if count == 1 else 'people'}"


def run_and_report(snapshot: dict, injected: list[dict], algorithm: str, values: dict) -> dict:
    simulation = build_simulation(snapshot, injected, algorithm, values)
    timeline = simulation.run_to_end(values["simulation_frame_seconds"])
    summary = simulation.summary()
    congestion = simulation.congestion_rows()
    names = {n["id"]: n["name"] for n in snapshot["nodes"]}

    # Static analysis at the start (bottlenecks, single points of failure).
    nodes, edges = _namespaces(snapshot["nodes"]), _namespaces(snapshot["edges"])
    hazards = _namespaces(snapshot["hazards"] + injected)
    start_hazard = hazard_context(
        nodes, edges, hazards, 0.0,
        horizon_minutes=values["hazard_risk_horizon_minutes"],
        risk_cost_metres=values["hazard_risk_cost_metres"],
        smoke_blocking_severity=values["smoke_blocking_severity"],
    )
    counts = {}
    for agent in snapshot["agents"]:
        key = (agent["node_id"], agent["mobility"], agent["kind"])
        counts[key] = counts.get(key, 0) + 1
    groups = [bottlenecks.Group(node_id=n, mobility=m, kind=k, people=c)
              for (n, m, k), c in sorted(counts.items())]
    static = bottlenecks.analyse(
        nodes, edges, groups, start_hazard, algorithm,
        queue_minutes_threshold=values["bottleneck_queue_minutes"],
        exit_imbalance_share=values["exit_imbalance_share"],
    )

    wait_threshold_s = values["bottleneck_queue_minutes"] * 60
    static_rows = {row["edge_id"]: row for row in static["edges"]}
    sim_rows = {row["edge_id"]: row for row in congestion}
    bottleneck_rows = []
    for edge_id in sorted(set(static_rows) | set(sim_rows)):
        s_row, c_row = static_rows.get(edge_id), sim_rows.get(edge_id)
        reasons = []
        if s_row and s_row["is_bottleneck"]:
            reasons.append("planned load exceeds capacity")
        if s_row and s_row["cut_off_people"]:
            reasons.append("single point of failure")
        if c_row and c_row["max_wait_s"] >= wait_threshold_s:
            reasons.append("long queue in simulation")
        if reasons:
            bottleneck_rows.append({
                "edge_id": edge_id,
                "label": (s_row or c_row)["label"],
                "queue_minutes": s_row["queue_minutes"] if s_row else None,
                "max_wait_s": c_row["max_wait_s"] if c_row else 0.0,
                "total_wait_s": c_row["total_wait_s"] if c_row else 0.0,
                "people": c_row["people"] if c_row else 0,
                "reasons": reasons,
            })

    recommendations = []
    stuck = [a for a in simulation.agent_rows() if a["status"] == "needs_assistance"]
    if stuck:
        where = {}
        for a in stuck:
            key = (names[a["start_node_id"]], a["mobility"])
            where[key] = where.get(key, 0) + 1
        detail = "; ".join(f"{c} {m} at {n}" for (n, m), c in sorted(where.items())[:5])
        recommendations.append({"severity": "critical", "node_ids": [], "edge_ids": [], "text":
            f"{_plain_people(len(stuck))} could not reach an exit safely and need assisted "
            f"evacuation ({detail})."})
    if summary["reached_by_hazard"]:
        recommendations.append({"severity": "critical", "node_ids": [], "edge_ids": [], "text":
            f"{_plain_people(summary['reached_by_hazard'])} were reached by the hazard before "
            "getting out. Start their evacuation earlier or plan routes away from the hazard."})
    if summary["timed_out"]:
        recommendations.append({"severity": "warning", "node_ids": [], "edge_ids": [], "text":
            f"{_plain_people(summary['still_moving'])} were still moving when the simulation "
            f"stopped at {summary['simulated_seconds'] / 60:.0f} minutes."})
    for row in congestion[:3]:
        if row["max_wait_s"] <= 0:
            continue
        severity = "warning" if row["max_wait_s"] >= wait_threshold_s else "info"
        recommendations.append({"severity": severity, "node_ids": [], "edge_ids": [row["edge_id"]],
            "text": f"People waited up to {row['max_wait_s']:.0f} s to enter {row['label']} "
                    f"({row['people']} people passed, longest queue {row['max_queue']})."})
    recommendations += [r for r in static["recommendations"]
                        if r["severity"] != "critical" and not r["text"].startswith("No bottlenecks")]
    if not summary["total"]:
        recommendations.insert(0, {"severity": "info", "node_ids": [], "edge_ids": [], "text":
            "Nobody is placed in this building. Add patients or staff with a location to "
            "simulate an evacuation."})
    elif not recommendations:
        recommendations.append({"severity": "info", "node_ids": [], "edge_ids": [], "text":
            f"Everyone reached an exit in {summary['evacuation_time_s']:.0f} s with no queue "
            "above the threshold."})

    return {
        "summary": summary,
        "timeline": timeline,
        "routes": simulation.agent_rows(),
        "congestion": congestion,
        "exit_load": simulation.exit_load(),
        "hazard_events": simulation.events,
        "bottlenecks": bottleneck_rows,
        "static_analysis": {"edges": static["edges"], "exits": static["exits"]},
        "recommendations": recommendations,
        "method": METHOD,
    }
