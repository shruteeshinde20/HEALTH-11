"""Simulation endpoints (PROJECT.md API contract):

- POST /simulate {scenario_id, algorithm, building_id?} -> {run_id}
- GET  /simulation_runs, GET /simulation_runs/{id}
- POST /simulations/{run_id}/hazards  (dynamic re-routing)
- POST /simulations/{run_id}/stream-token -> {token, expires_in}  (opens the WebSocket)
- POST /compare {scenario_id, building_id?} -> [{algorithm, evacuation_time_s, distance_m, risk}]
- GET  /dashboard -> {hospitals, scenarios, last_evacuation_time_s, bottlenecks}
- WS   /ws/simulations/{run_id}?token=...  (see simulation_ws.py)

Starting simulations, comparisons and adding hazards: Administrator or
Emergency Commander. Viewing runs, watching them live and the dashboard:
any signed-in user.
"""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api_common import (
    Id,
    Name,
    Page,
    PageParams,
    get_active,
    page_params,
    paginate,
    require_reference,
)
from app.audit import record_audit
from app.auth import issue_stream_token
from app.db_session import get_db
from app.models.facility import Building, Hospital
from app.models.operations import HazardType, Scenario
from app.models.simulation import SimulationRun
from app.permissions import Editor, Reader
from app.services import ml
from app.services import simulation_runner as runner
from app.services.routing import ALGORITHMS

router = APIRouter(tags=["Simulation"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]
Algorithm = Annotated[str, Field(pattern="^(bfs|dfs|dijkstra|astar)$")]


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: Id
    algorithm: Algorithm = "astar"
    building_id: Id | None = None


class CompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: Id
    building_id: Id | None = None


class InjectedHazard(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200)
    type: HazardType
    origin_node_id: Id
    spread_rate: Annotated[float, Field(ge=0, le=1000, allow_inf_nan=False)] = 0.0
    severity: Annotated[int, Field(ge=1, le=5)] = 3
    at_seconds: Annotated[float, Field(ge=0, le=36_000, allow_inf_nan=False)]


class RunSummaryOut(BaseModel):
    id: int
    scenario_id: int
    building_id: int | None
    algorithm: str
    status: str
    created_at: datetime
    updated_at: datetime
    summary: dict[str, Any] | None


def _run_summary(run: SimulationRun) -> RunSummaryOut:
    return RunSummaryOut(
        id=run.id, scenario_id=run.scenario_id,
        building_id=(run.params or {}).get("snapshot", {}).get("building_id"),
        algorithm=run.algorithm, status=run.status, created_at=run.created_at,
        updated_at=run.updated_at, summary=(run.results or {}).get("summary"),
    )


def _prepare(db: Session, user, scenario_id: int, building_id: int | None):
    org = user.organization_id
    require_reference(db, Scenario, scenario_id, org, "Scenario")
    if building_id is None:
        building_id = runner.building_for_scenario(db, org, scenario_id)
    else:
        require_reference(db, Building, building_id, org, "Building")
    snapshot = runner.take_snapshot(db, org, scenario_id, building_id)
    params = runner.parameters(db, org)
    return snapshot, params


@router.post("/simulate", status_code=status.HTTP_201_CREATED)
def simulate(payload: SimulateRequest, db: Db, user: Editor, request: Request):
    snapshot, params = _prepare(db, user, payload.scenario_id, payload.building_id)
    values = {name: p.value for name, p in params.items()}
    results = runner.run_and_report(snapshot, [], payload.algorithm, values)
    run = SimulationRun(
        organization_id=user.organization_id,
        scenario_id=payload.scenario_id,
        algorithm=payload.algorithm,
        params={
            "snapshot": snapshot,
            "values": values,
            "parameters_used": runner.parameters_used(params),
            "injected_hazards": [],
            # Inputs as numbers, used to train the evacuation-time predictor.
            "features": ml.features(snapshot, [], payload.algorithm, values),
        },
        results=results,
        status="completed",
    )
    db.add(run)
    db.flush()
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="simulation.created", entity_type="simulation_run", entity_id=run.id,
                 request=request, details={"scenario_id": payload.scenario_id,
                                           "algorithm": payload.algorithm,
                                           "people": results["summary"]["total"]})
    db.commit()
    return {"run_id": run.id}


@router.get("/simulation_runs", response_model=Page[RunSummaryOut])
def list_runs(
    db: Db, user: Reader, paging: Paging,
    scenario_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(SimulationRun).where(
        SimulationRun.organization_id == user.organization_id,
        SimulationRun.deleted_at.is_(None),
    )
    if scenario_id is not None:
        stmt = stmt.where(SimulationRun.scenario_id == scenario_id)
    page = paginate(db, stmt, paging, SimulationRun.id.desc())
    page["items"] = [_run_summary(run) for run in page["items"]]
    return page


@router.get("/simulation_runs/{run_id}")
def get_run(run_id: int, db: Db, user: Reader):
    run = get_active(db, SimulationRun, run_id, user.organization_id, "Simulation run")
    results = run.results or {}
    return {
        **_run_summary(run).model_dump(),
        "parameters_used": run.params.get("parameters_used", []),
        "injected_hazards": run.params.get("injected_hazards", []),
        "method": results.get("method", []),
        "timeline": results.get("timeline", []),
        "routes": results.get("routes", []),
        "congestion": results.get("congestion", []),
        "exit_load": results.get("exit_load", {}),
        "hazard_events": results.get("hazard_events", []),
        "bottlenecks": results.get("bottlenecks", []),
        "static_analysis": results.get("static_analysis", {}),
        "recommendations": results.get("recommendations", []),
        "map": run_map(run.params.get("snapshot") or {}),
    }


def run_map(snapshot: dict) -> dict:
    """The building as it was when the run started, for drawing the live view.

    Places and paths only; no people (their positions come from the stream).
    """
    return {
        "building_id": snapshot.get("building_id"),
        "nodes": [{key: node.get(key) for key in ("id", "name", "type", "x", "y", "floor_id", "is_blocked")}
                  for node in snapshot.get("nodes", [])],
        "edges": [{key: edge.get(key) for key in ("id", "from_node_id", "to_node_id", "is_blocked")}
                  for edge in snapshot.get("edges", [])],
    }


@router.post("/simulations/{run_id}/stream-token")
def stream_token(run_id: int, db: Db, user: Reader):
    """A 60-second token that opens /ws/simulations/{run_id} and nothing else."""
    get_active(db, SimulationRun, run_id, user.organization_id, "Simulation run")
    token, lifetime = issue_stream_token(user, run_id)
    return {"token": token, "expires_in": lifetime}


@router.post("/simulations/{run_id}/hazards", status_code=status.HTTP_201_CREATED)
def add_hazard_to_run(run_id: int, payload: InjectedHazard, db: Db, user: Editor, request: Request):
    """Add a hazard that appears at `at_seconds`; everyone re-routes from then on."""
    run = get_active(db, SimulationRun, run_id, user.organization_id, "Simulation run")
    snapshot = run.params["snapshot"]
    if payload.origin_node_id not in {n["id"] for n in snapshot["nodes"]}:
        raise HTTPException(status_code=422,
                            detail="origin_node_id must be a node of this run's building")
    injected = list(run.params.get("injected_hazards", []))
    hazard = {
        "id": -(len(injected) + 1),
        "name": payload.name,
        "type": payload.type.value,
        "origin_node_id": payload.origin_node_id,
        "spread_rate": payload.spread_rate,
        "severity": payload.severity,
        "is_active": True,
        "start_minutes": payload.at_seconds / 60.0,
    }
    injected.append(hazard)
    results = runner.run_and_report(snapshot, injected, run.algorithm, run.params["values"])
    # New dict objects so SQLAlchemy saves the JSON changes.
    run.params = {**run.params, "injected_hazards": injected,
                  "features": ml.features(snapshot, injected, run.algorithm, run.params["values"])}
    run.results = results
    run.updated_at = func.now()
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action="simulation.hazard_added", entity_type="simulation_run", entity_id=run.id,
                 request=request, details={"hazard_id": hazard["id"], "type": hazard["type"],
                                           "origin_node_id": hazard["origin_node_id"],
                                           "at_seconds": payload.at_seconds})
    db.commit()
    return {"run_id": run.id, "hazard": hazard, "summary": results["summary"]}


@router.post("/compare")
def compare(payload: CompareRequest, db: Db, user: Editor):
    """Run the same scenario with every algorithm (nothing is saved)."""
    snapshot, params = _prepare(db, user, payload.scenario_id, payload.building_id)
    values = {name: p.value for name, p in params.items()}
    rows = []
    for algorithm in ALGORITHMS:
        simulation = runner.build_simulation(snapshot, [], algorithm, values)
        simulation.run_to_end()
        summary = simulation.summary()
        rows.append({
            "algorithm": algorithm,
            "evacuation_time_s": summary["evacuation_time_s"],
            "distance_m": summary["mean_distance_m"],
            "risk": summary["mean_risk_exposure"],
            "all_evacuated": summary["all_evacuated"],
            "evacuated": summary["evacuated"],
            "total": summary["total"],
            "needs_assistance": summary["needs_assistance"],
            "reached_by_hazard": summary["reached_by_hazard"],
        })
    return rows


@router.get("/dashboard")
def dashboard(db: Db, user: Reader):
    org = user.organization_id
    hospitals = db.scalar(select(func.count()).select_from(Hospital).where(
        Hospital.organization_id == org, Hospital.deleted_at.is_(None))) or 0
    scenarios = db.scalar(select(func.count()).select_from(Scenario).where(
        Scenario.organization_id == org, Scenario.deleted_at.is_(None),
        Scenario.is_active.is_(True))) or 0
    last = db.scalar(select(SimulationRun).where(
        SimulationRun.organization_id == org, SimulationRun.deleted_at.is_(None),
        SimulationRun.status == "completed").order_by(SimulationRun.id.desc()).limit(1))
    if last is None:
        return {"hospitals": hospitals, "scenarios": scenarios, "last_evacuation_time_s": None,
                "bottlenecks": [], "last_run": None,
                "note": "No simulation has been run yet."}
    summary = last.results["summary"]
    return {
        "hospitals": hospitals,
        "scenarios": scenarios,
        # Only a complete evacuation has an evacuation time.
        "last_evacuation_time_s": summary["evacuation_time_s"] if summary["all_evacuated"] else None,
        "bottlenecks": last.results.get("bottlenecks", []),
        "last_run": _run_summary(last).model_dump(),
        "note": None if summary["all_evacuated"] else
        "The last simulation did not evacuate everyone; see its recommendations.",
    }
