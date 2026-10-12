"""Simulation parameters (PROJECT.md: name, value, unit, source).

`source` is required: a citation (for example NFPA or NIST research) or, if
none exists, the text "assumed, to be validated".
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api_common import (
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
from app.models.simulation import Parameter
from app.permissions import Editor, Reader

router = APIRouter(tags=["Parameters"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

CONFLICT = "A parameter with this name already exists"


class ParameterCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(150)
    value: Name(1000)
    unit: OptionalText(100) = None
    source: Name(300)


class ParameterUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(150) | None = None
    value: Name(1000) | None = None
    unit: OptionalText(100) = None
    source: Name(300) | None = None


class ParameterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    name: str
    value: str
    unit: str | None
    source: str
    created_at: datetime
    updated_at: datetime


def _audit(db, user, request, action, entity_id, details=None):
    record_audit(
        db, organization_id=user.organization_id, actor_user_id=user.id,
        action=action, entity_type="parameter", entity_id=entity_id,
        request=request, details=details,
    )


@router.get("/parameters", response_model=Page[ParameterOut])
def list_parameters(db: Db, user: Reader, paging: Paging, q: SearchQuery = None):
    stmt = select(Parameter).where(
        Parameter.organization_id == user.organization_id, Parameter.deleted_at.is_(None)
    )
    matches = [m for m in (contains(Parameter.name, q), contains(Parameter.source, q)) if m is not None]
    if matches:
        stmt = stmt.where(or_(*matches))
    return paginate(db, stmt, paging, Parameter.name, Parameter.id)


@router.get("/parameters/{parameter_id}", response_model=ParameterOut)
def get_parameter(parameter_id: int, db: Db, user: Reader):
    return get_active(db, Parameter, parameter_id, user.organization_id, "Parameter")


@router.post("/parameters", response_model=ParameterOut, status_code=status.HTTP_201_CREATED)
def create_parameter(payload: ParameterCreate, db: Db, user: Editor, request: Request):
    parameter = Parameter(organization_id=user.organization_id, **payload.model_dump())
    db.add(parameter)
    flush_or_conflict(db, CONFLICT)
    _audit(db, user, request, "parameter.created", parameter.id)
    commit_or_conflict(db, CONFLICT)
    db.refresh(parameter)
    return parameter


@router.patch("/parameters/{parameter_id}", response_model=ParameterOut)
def update_parameter(parameter_id: int, payload: ParameterUpdate, db: Db, user: Editor, request: Request):
    parameter = get_active(db, Parameter, parameter_id, user.organization_id, "Parameter")
    changes = changes_from(payload, not_null={"name", "value", "source"})
    for field, value in changes.items():
        setattr(parameter, field, value)
    flush_or_conflict(db, CONFLICT)
    _audit(db, user, request, "parameter.updated", parameter.id, {"fields": sorted(changes)})
    commit_or_conflict(db, CONFLICT)
    db.refresh(parameter)
    return parameter


@router.delete("/parameters/{parameter_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_parameter(parameter_id: int, db: Db, user: Editor, request: Request):
    parameter = get_active(db, Parameter, parameter_id, user.organization_id, "Parameter")
    parameter.deleted_at = func.now()
    _audit(db, user, request, "parameter.deleted", parameter.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
