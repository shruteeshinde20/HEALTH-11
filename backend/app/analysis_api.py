"""POST /scenarios/{scenario_id}/analysis — hazards, bottlenecks and
recommendations for one building at one moment of a scenario.

Read-only: nothing is saved (saved simulation runs come with the tick-based
simulation, build step 9). Any signed-in user of the organization may run it.
"""

from collections import Counter
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api_common import Id, get_active, require_reference
from app.db_session import get_db
from app.models.facility import Building
from app.models.operations import Patient, Scenario, Staff
from app.permissions import Reader
from app.services import bottlenecks
from app.services.routing import ALGORITHMS
from app.services.scenario_inputs import building_nodes_and_edges, scenario_hazard_context

router = APIRouter(tags=["Hazards and bottlenecks"])

Db = Annotated[Session, Depends(get_db)]

ANALYSIS_PARAMETERS = ["bottleneck_queue_minutes", "exit_imbalance_share"]

METHOD = [
    "Hazards spread along the building graph at their spread rate (metres per minute); "
    "a node is reached when the spread distance from the origin is covered. "
    "This is an algorithmic model, not machine learning.",
    "Fire, hazmat and structural hazards block the nodes they reach; smoke blocks at or "
    "above smoke_blocking_severity and otherwise adds risk. During fire or smoke only "
    "evacuation lifts are used.",
    "Every group of people (same location and mobility) is routed to its nearest safe exit. "
    "Edge load is the number of people routed through it; queue minutes = load / max_flow "
    "(max_flow is read as people per minute).",
    "Betweenness share is the fraction of (occupied location, exit) pairs whose cheapest "
    "path uses the edge. A single point of failure is a used edge whose loss leaves people "
    "with no exit.",
    "Limits: everyone leaves at once; walking speeds, crowd behaviour, doors, ventilation "
    "and staff assistance are not modelled. Use for planning and training only; this does "
    "not replace official emergency procedures.",
]


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    building_id: Id
    minutes_elapsed: Annotated[float, Field(ge=0, le=1440, allow_inf_nan=False)] = 0.0
    algorithm: str = "astar"


def _occupant_groups(db: Session, organization_id: int, node_ids: list[int]):
    counts = Counter()
    if node_ids:
        for node_id, mobility in db.execute(
            select(Patient.node_id, Patient.mobility).where(
                Patient.organization_id == organization_id,
                Patient.node_id.in_(node_ids),
                Patient.deleted_at.is_(None),
            )
        ):
            counts[(node_id, mobility.value, "patient")] += 1
        for (node_id,) in db.execute(
            select(Staff.node_id).where(
                Staff.organization_id == organization_id,
                Staff.node_id.in_(node_ids),
                Staff.deleted_at.is_(None),
            )
        ):
            counts[(node_id, "ambulatory", "staff")] += 1
    return [
        bottlenecks.Group(node_id=node_id, mobility=mobility, kind=kind, people=people)
        for (node_id, mobility, kind), people in sorted(counts.items())
    ]


@router.post("/scenarios/{scenario_id}/analysis")
def analyse_scenario(scenario_id: int, payload: AnalysisRequest, db: Db, user: Reader):
    org = user.organization_id
    scenario = get_active(db, Scenario, scenario_id, org, "Scenario")
    building = require_reference(db, Building, payload.building_id, org, "Building")
    algorithm = payload.algorithm.lower()
    if algorithm not in ALGORITHMS:
        raise HTTPException(status_code=422, detail=f"Unsupported algorithm: {algorithm}")

    nodes, edges = building_nodes_and_edges(db, building.id, org)
    hazard, params = scenario_hazard_context(
        db, org, scenario.id, nodes, edges, payload.minutes_elapsed, ANALYSIS_PARAMETERS,
    )
    groups = _occupant_groups(db, org, [node.id for node in nodes])
    result = bottlenecks.analyse(
        nodes, edges, groups, hazard, algorithm,
        queue_minutes_threshold=params["bottleneck_queue_minutes"].value,
        exit_imbalance_share=params["exit_imbalance_share"].value,
    )

    node_by_id = {node.id: node for node in nodes}
    unplaced_patients = db.scalar(
        select(func.count()).select_from(Patient).where(
            Patient.organization_id == org,
            Patient.node_id.is_(None),
            Patient.deleted_at.is_(None),
        )
    ) or 0

    return {
        "scenario_id": scenario.id,
        "building_id": building.id,
        "minutes_elapsed": payload.minutes_elapsed,
        "algorithm": algorithm,
        "method": METHOD,
        "parameters_used": [
            {"name": p.name, "value": p.value, "unit": p.unit, "source": p.source, "meaning": p.meaning}
            for p in params.values()
        ],
        "hazard": {
            "lifts_disabled": hazard.lifts_disabled,
            "ignored_hazard_ids": hazard.ignored_hazard_ids,
            "nodes": [
                {
                    "node_id": node_id,
                    "name": node_by_id[node_id].name,
                    "floor_id": node_by_id[node_id].floor_id,
                    "risk": state.risk,
                    "blocked": state.blocked,
                    "arrival_minutes": None if state.arrival_minutes is None
                    else round(state.arrival_minutes, 3),
                }
                for node_id, state in sorted(hazard.nodes.items())
            ],
        },
        "unplaced_patients_in_organization": unplaced_patients,
        **result,
    }
