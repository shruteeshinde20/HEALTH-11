"""Scenarios with their hazards (PROJECT.md: "/scenarios (with hazards)").

A scenario is created or edited together with its list of hazards. When a
PATCH includes `hazards`, that list replaces the previous one (the old
hazards are soft-deleted, so history stays in the database).
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api_common import (
    Id,
    Name,
    OptionalText,
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
)
from app.audit import record_audit
from app.db_session import get_db
from app.models.graph import Node
from app.models.operations import Hazard, HazardType, Scenario
from app.permissions import Editor, Reader

router = APIRouter(tags=["Scenarios"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

CONFLICT = "A scenario with this name already exists"
MAX_HAZARDS = 50


class HazardIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200)
    type: HazardType
    origin_node_id: Id
    spread_rate: Annotated[float, Field(ge=0, le=1000, allow_inf_nan=False)] = 0.0
    severity: Annotated[int, Field(ge=1, le=5)] = 1
    is_active: bool = True


class HazardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    type: HazardType
    origin_node_id: int
    spread_rate: float
    severity: int
    is_active: bool


Hazards = Annotated[list[HazardIn], Field(max_length=MAX_HAZARDS)]


class ScenarioCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200)
    description: OptionalText(5000) = None
    is_active: bool = True
    hazards: Hazards = []


class ScenarioUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200) | None = None
    description: OptionalText(5000) = None
    is_active: bool | None = None
    hazards: Hazards | None = None


class ScenarioOut(BaseModel):
    id: int
    organization_id: int
    name: str
    description: str | None
    is_active: bool
    created_by_user_id: int | None
    hazards: list[HazardOut]
    created_at: datetime
    updated_at: datetime


def _hazards_by_scenario(db: Session, organization_id: int, scenario_ids: list[int]):
    grouped: dict[int, list[Hazard]] = {scenario_id: [] for scenario_id in scenario_ids}
    if scenario_ids:
        for hazard in db.scalars(
            select(Hazard).where(
                Hazard.organization_id == organization_id,
                Hazard.scenario_id.in_(scenario_ids),
                Hazard.deleted_at.is_(None),
            ).order_by(Hazard.id)
        ):
            grouped[hazard.scenario_id].append(hazard)
    return grouped


def _out(scenario: Scenario, hazards: list[Hazard]) -> ScenarioOut:
    return ScenarioOut(
        id=scenario.id,
        organization_id=scenario.organization_id,
        name=scenario.name,
        description=scenario.description,
        is_active=scenario.is_active,
        created_by_user_id=scenario.created_by_user_id,
        hazards=[HazardOut.model_validate(h) for h in hazards],
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


def _check_origin_nodes(db: Session, organization_id: int, hazards: list[HazardIn]) -> None:
    wanted = {hazard.origin_node_id for hazard in hazards}
    if not wanted:
        return
    found = set(db.scalars(
        select(Node.id).where(
            Node.id.in_(wanted),
            Node.organization_id == organization_id,
            Node.deleted_at.is_(None),
        )
    ))
    missing = sorted(wanted - found)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Hazard origin node(s) {missing} do not exist in your organization",
        )


def _add_hazards(db: Session, scenario: Scenario, hazards: list[HazardIn]) -> None:
    for hazard in hazards:
        db.add(Hazard(
            organization_id=scenario.organization_id,
            scenario_id=scenario.id,
            **hazard.model_dump(),
        ))


def _audit(db, user, request, action, entity_id, details=None):
    record_audit(
        db, organization_id=user.organization_id, actor_user_id=user.id,
        action=action, entity_type="scenario", entity_id=entity_id,
        request=request, details=details,
    )


@router.get("/scenarios", response_model=Page[ScenarioOut])
def list_scenarios(db: Db, user: Reader, paging: Paging, q: SearchQuery = None):
    stmt = select(Scenario).where(
        Scenario.organization_id == user.organization_id, Scenario.deleted_at.is_(None)
    )
    if (match := contains(Scenario.name, q)) is not None:
        stmt = stmt.where(match)
    page = paginate(db, stmt, paging, Scenario.name, Scenario.id)
    hazards = _hazards_by_scenario(db, user.organization_id, [s.id for s in page["items"]])
    page["items"] = [_out(s, hazards[s.id]) for s in page["items"]]
    return page


@router.get("/scenarios/{scenario_id}", response_model=ScenarioOut)
def get_scenario(scenario_id: int, db: Db, user: Reader):
    scenario = get_active(db, Scenario, scenario_id, user.organization_id, "Scenario")
    return _out(scenario, _hazards_by_scenario(db, user.organization_id, [scenario.id])[scenario.id])


@router.post("/scenarios", response_model=ScenarioOut, status_code=status.HTTP_201_CREATED)
def create_scenario(payload: ScenarioCreate, db: Db, user: Editor, request: Request):
    _check_origin_nodes(db, user.organization_id, payload.hazards)
    scenario = Scenario(
        organization_id=user.organization_id,
        created_by_user_id=user.id,
        **payload.model_dump(exclude={"hazards"}),
    )
    db.add(scenario)
    flush_or_conflict(db, CONFLICT)
    _add_hazards(db, scenario, payload.hazards)
    _audit(db, user, request, "scenario.created", scenario.id, {"hazards": len(payload.hazards)})
    commit_or_conflict(db, CONFLICT)
    db.refresh(scenario)
    return get_scenario(scenario.id, db, user)


@router.patch("/scenarios/{scenario_id}", response_model=ScenarioOut)
def update_scenario(scenario_id: int, payload: ScenarioUpdate, db: Db, user: Editor, request: Request):
    scenario = get_active(db, Scenario, scenario_id, user.organization_id, "Scenario")
    changes = changes_from(payload, not_null={"name", "is_active", "hazards"})
    new_hazards = changes.pop("hazards", None)
    if new_hazards is not None:
        _check_origin_nodes(db, user.organization_id, payload.hazards)
    for field, value in changes.items():
        setattr(scenario, field, value)
    flush_or_conflict(db, CONFLICT)
    details = {"fields": sorted(changes)}
    if new_hazards is not None:
        db.execute(
            update(Hazard)
            .where(
                Hazard.organization_id == user.organization_id,
                Hazard.scenario_id == scenario.id,
                Hazard.deleted_at.is_(None),
            )
            .values(deleted_at=func.now())
        )
        _add_hazards(db, scenario, payload.hazards)
        scenario.updated_at = func.now()
        details["hazards_replaced"] = len(payload.hazards)
    _audit(db, user, request, "scenario.updated", scenario.id, details)
    commit_or_conflict(db, CONFLICT)
    db.refresh(scenario)
    return get_scenario(scenario.id, db, user)


@router.delete("/scenarios/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_scenario(scenario_id: int, db: Db, user: Editor, request: Request):
    scenario = get_active(db, Scenario, scenario_id, user.organization_id, "Scenario")
    db.execute(
        update(Hazard)
        .where(
            Hazard.organization_id == user.organization_id,
            Hazard.scenario_id == scenario.id,
            Hazard.deleted_at.is_(None),
        )
        .values(deleted_at=func.now())
    )
    scenario.deleted_at = func.now()
    _audit(db, user, request, "scenario.deleted", scenario.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
