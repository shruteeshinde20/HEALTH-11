"""Evacuation plans (PROJECT.md data model: evacuation_plans).

A plan is saved from a finished simulation run and keeps its own copy of
what staff need to act on: for each starting place and mobility, the route
by place names, the exit, how many people and when the last of them was out;
who needs assisted evacuation; exit load, bottlenecks and recommendations.
The copy is taken when the plan is saved, so later changes to the run (for
example a hazard added afterwards) or to the floor plan do not change an
approved plan.

- POST   /evacuation_plans {run_id, name}       -> the new plan (status "draft")
- GET    /evacuation_plans                      -> {items, total, limit, offset}
         ?scenario_id= ?status= ?q=             (filters)
- GET    /evacuation_plans/{id}                 -> the plan with its instructions
- PATCH  /evacuation_plans/{id} {name?, status?}
- DELETE /evacuation_plans/{id}                 (soft delete)

Status: "draft", "approved" or "archived". Approving records who approved
and when; going back to draft clears that.

Saving, changing and deleting plans: Administrator or Emergency Commander.
Reading plans: any signed-in user of the organization.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_common import (
    Id,
    Name,
    Page,
    PageParams,
    SearchQuery,
    changes_from,
    commit_or_conflict,
    contains,
    flush_or_conflict,
    get_active,
    page_params,
    paginate,
    require_reference,
    soft_delete,
)
from app.audit import record_audit
from app.db_session import get_db
from app.models.operations import Scenario
from app.models.simulation import EvacuationPlan, SimulationRun
from app.permissions import Editor, Reader

router = APIRouter(tags=["Evacuation plans"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

CONFLICT = "An evacuation plan with this name already exists"


class PlanStatus(str, Enum):
    DRAFT = "draft"
    APPROVED = "approved"
    ARCHIVED = "archived"


class PlanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: Id
    name: Name(200)


class PlanUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200) | None = None
    status: PlanStatus | None = None


class PlanSummaryOut(BaseModel):
    id: int
    name: str
    status: PlanStatus
    scenario_id: int
    scenario_name: str | None
    source_run_id: int | None
    algorithm: str | None
    total: int | None
    evacuated: int | None
    needs_assistance: int | None
    evacuation_time_s: float | None
    approved_by: str | None
    approved_at: str | None
    created_at: datetime
    updated_at: datetime


# --- building the plan from a run -----------------------------------------------------------

def _instructions(snapshot: dict, rows: list[dict]) -> list[dict]:
    """One instruction per (starting place, kind, mobility, route), in plain names."""
    names = {n["id"]: n["name"] for n in snapshot.get("nodes", [])}
    groups: dict[tuple, dict] = {}
    for row in rows:
        route = list(row.get("initial_route") or [])
        assisted = row.get("status") == "needs_assistance" or not route
        key = (row.get("start_node_id"), row.get("kind"), row.get("mobility"), tuple(route), assisted)
        group = groups.get(key)
        if group is None:
            exit_id = route[-1] if route and not assisted else None
            group = groups[key] = {
                "start_node_id": row.get("start_node_id"),
                "start": names.get(row.get("start_node_id"), "?"),
                "kind": row.get("kind"),
                "mobility": row.get("mobility"),
                "route_node_ids": [] if assisted else route,
                "route": [] if assisted else [names.get(n, "?") for n in route],
                "exit": names.get(exit_id) if exit_id is not None else None,
                "needs_assistance": assisted,
                "people": 0,
                "last_out_s": None,
            }
        group["people"] += 1
        out = row.get("evacuated_at_s")
        if out is not None and (group["last_out_s"] is None or out > group["last_out_s"]):
            group["last_out_s"] = out
    # People who need assisted evacuation first, then by starting place.
    return sorted(groups.values(), key=lambda g: (
        0 if g["needs_assistance"] else 1, g["start"], g["kind"] or "", g["mobility"] or "", g["route"]))


def plan_content(run: SimulationRun) -> dict[str, Any]:
    params = run.params or {}
    results = run.results or {}
    snapshot = params.get("snapshot") or {}
    names = {n["id"]: n["name"] for n in snapshot.get("nodes", [])}
    exit_load = {}
    for node_id, count in (results.get("exit_load") or {}).items():
        label = names.get(int(node_id)) if str(node_id).lstrip("-").isdigit() else None
        exit_load[label or str(node_id)] = count
    hazards = [{"name": h.get("name"), "type": h.get("type"), "origin": names.get(h.get("origin_node_id")),
                "severity": h.get("severity"), "starts_at_s": round(60 * (h.get("start_minutes") or 0), 1)}
               for h in (snapshot.get("hazards") or []) + (params.get("injected_hazards") or [])]
    return {
        "source_run_id": run.id,
        "algorithm": run.algorithm,
        "building_id": snapshot.get("building_id"),
        "run_created_at": run.created_at.isoformat() if run.created_at else None,
        "summary": results.get("summary") or {},
        "hazards": hazards,
        "instructions": _instructions(snapshot, results.get("routes") or []),
        "exit_load": exit_load,
        "bottlenecks": results.get("bottlenecks") or [],
        "recommendations": results.get("recommendations") or [],
        "parameters_used": params.get("parameters_used") or [],
        "approval": None,
    }


# --- output ---------------------------------------------------------------------------------

def _scenario_names(db: Session, organization_id: int, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(select(Scenario.id, Scenario.name).where(
        Scenario.organization_id == organization_id, Scenario.id.in_(ids)))
    return {row.id: row.name for row in rows}


def _summary(plan: EvacuationPlan, scenario_name: str | None) -> PlanSummaryOut:
    content = plan.routes or {}
    summary = content.get("summary") or {}
    approval = content.get("approval") or {}
    return PlanSummaryOut(
        id=plan.id, name=plan.name, status=plan.status, scenario_id=plan.scenario_id,
        scenario_name=scenario_name, source_run_id=content.get("source_run_id"),
        algorithm=content.get("algorithm"), total=summary.get("total"),
        evacuated=summary.get("evacuated"), needs_assistance=summary.get("needs_assistance"),
        evacuation_time_s=summary.get("evacuation_time_s"),
        approved_by=approval.get("by"), approved_at=approval.get("at"),
        created_at=plan.created_at, updated_at=plan.updated_at,
    )


def _detail(db: Session, plan: EvacuationPlan) -> dict[str, Any]:
    name = _scenario_names(db, plan.organization_id, {plan.scenario_id}).get(plan.scenario_id)
    content = plan.routes or {}
    return {
        **_summary(plan, name).model_dump(mode="json"),
        "building_id": content.get("building_id"),
        "run_created_at": content.get("run_created_at"),
        "summary": content.get("summary") or {},
        "hazards": content.get("hazards") or [],
        "instructions": content.get("instructions") or [],
        "exit_load": content.get("exit_load") or {},
        "bottlenecks": content.get("bottlenecks") or [],
        "recommendations": content.get("recommendations") or [],
        "parameters_used": content.get("parameters_used") or [],
    }


def _audit(db, user, request, action, entity_id, details=None):
    record_audit(db, organization_id=user.organization_id, actor_user_id=user.id,
                 action=action, entity_type="evacuation_plan", entity_id=entity_id,
                 request=request, details=details)


# --- endpoints ------------------------------------------------------------------------------

@router.post("/evacuation_plans", status_code=status.HTTP_201_CREATED)
def create_plan(payload: PlanCreate, db: Db, user: Editor, request: Request):
    run = require_reference(db, SimulationRun, payload.run_id, user.organization_id, "Simulation run")
    if run.status != "completed" or not run.results:
        raise HTTPException(status_code=422, detail="Only a completed simulation run can be saved as a plan")
    plan = EvacuationPlan(
        organization_id=user.organization_id,
        scenario_id=run.scenario_id,
        name=payload.name,
        routes=plan_content(run),
        status=PlanStatus.DRAFT.value,
    )
    db.add(plan)
    flush_or_conflict(db, CONFLICT)
    _audit(db, user, request, "evacuation_plan.created", plan.id, {"run_id": run.id})
    commit_or_conflict(db, CONFLICT)
    db.refresh(plan)
    return _detail(db, plan)


@router.get("/evacuation_plans", response_model=Page[PlanSummaryOut])
def list_plans(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    scenario_id: Annotated[int | None, Query(gt=0)] = None,
    plan_status: Annotated[PlanStatus | None, Query(alias="status")] = None,
):
    stmt = select(EvacuationPlan).where(
        EvacuationPlan.organization_id == user.organization_id,
        EvacuationPlan.deleted_at.is_(None),
    )
    if scenario_id is not None:
        stmt = stmt.where(EvacuationPlan.scenario_id == scenario_id)
    if plan_status is not None:
        stmt = stmt.where(EvacuationPlan.status == plan_status.value)
    if (match := contains(EvacuationPlan.name, q)) is not None:
        stmt = stmt.where(match)
    page = paginate(db, stmt, paging, EvacuationPlan.id.desc())
    names = _scenario_names(db, user.organization_id, {p.scenario_id for p in page["items"]})
    page["items"] = [_summary(p, names.get(p.scenario_id)) for p in page["items"]]
    return page


@router.get("/evacuation_plans/{plan_id}")
def get_plan(plan_id: int, db: Db, user: Reader):
    plan = get_active(db, EvacuationPlan, plan_id, user.organization_id, "Evacuation plan")
    return _detail(db, plan)


@router.patch("/evacuation_plans/{plan_id}")
def update_plan(plan_id: int, payload: PlanUpdate, db: Db, user: Editor, request: Request):
    plan = get_active(db, EvacuationPlan, plan_id, user.organization_id, "Evacuation plan")
    changes = changes_from(payload, not_null={"name", "status"})
    if "name" in changes:
        plan.name = changes["name"]
    details: dict[str, Any] = {"fields": sorted(changes)}
    new_status = changes.get("status")
    if new_status is not None and new_status.value != plan.status:
        content = dict(plan.routes or {})
        if new_status is PlanStatus.APPROVED:
            content["approval"] = {"by": user.full_name, "by_user_id": user.id,
                                   "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        elif new_status is PlanStatus.DRAFT:
            content["approval"] = None
        # A new dict object so SQLAlchemy saves the JSON change.
        plan.routes = content
        details["status"] = {"from": plan.status, "to": new_status.value}
        plan.status = new_status.value
    flush_or_conflict(db, CONFLICT)
    _audit(db, user, request, "evacuation_plan.updated", plan.id, details)
    commit_or_conflict(db, CONFLICT)
    db.refresh(plan)
    return _detail(db, plan)


@router.delete("/evacuation_plans/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan(plan_id: int, db: Db, user: Editor, request: Request):
    plan = get_active(db, EvacuationPlan, plan_id, user.organization_id, "Evacuation plan")
    soft_delete(plan)
    _audit(db, user, request, "evacuation_plan.deleted", plan.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
