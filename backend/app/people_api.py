"""Patients and staff (PROJECT.md API contract).

Reads: any signed-in user (Staff Users see Patients & Staff read-only).
Writes: Administrator or Emergency Commander.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
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
)
from app.audit import record_audit
from app.db_session import get_db
from app.models.graph import Node
from app.models.operations import Patient, PatientMobility, Staff
from app.permissions import Editor, Reader

router = APIRouter(tags=["Patients and Staff"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

PATIENT_CONFLICT = "A patient with this code already exists"
STAFF_CONFLICT = "A staff member with this code already exists"

Criticality = Annotated[int, Field(ge=1, le=5)]


class PatientCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_code: Name(100)
    mobility: PatientMobility
    criticality: Criticality = 3
    node_id: Id | None = None
    is_synthetic: bool = False


class PatientUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_code: Name(100) | None = None
    mobility: PatientMobility | None = None
    criticality: Criticality | None = None
    node_id: Id | None = None
    is_synthetic: bool | None = None


class PatientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    patient_code: str
    mobility: PatientMobility
    criticality: int
    node_id: int | None
    is_synthetic: bool
    created_at: datetime
    updated_at: datetime


class StaffCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    staff_code: Name(100)
    full_name: Name(200)
    role: Name(100)
    node_id: Id | None = None
    is_synthetic: bool = False


class StaffUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    staff_code: Name(100) | None = None
    full_name: Name(200) | None = None
    role: Name(100) | None = None
    node_id: Id | None = None
    is_synthetic: bool | None = None


class StaffOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    staff_code: str
    full_name: str
    role: str
    node_id: int | None
    is_synthetic: bool
    created_at: datetime
    updated_at: datetime


def _audit(db, user, request, action, entity_type, entity_id, details=None):
    record_audit(
        db, organization_id=user.organization_id, actor_user_id=user.id,
        action=action, entity_type=entity_type, entity_id=entity_id,
        request=request, details=details,
    )


# --- Patients -----------------------------------------------------------------------------

@router.get("/patients", response_model=Page[PatientOut])
def list_patients(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    node_id: Annotated[int | None, Query(gt=0)] = None,
    mobility: PatientMobility | None = None,
):
    stmt = select(Patient).where(
        Patient.organization_id == user.organization_id, Patient.deleted_at.is_(None)
    )
    if node_id is not None:
        stmt = stmt.where(Patient.node_id == node_id)
    if mobility is not None:
        stmt = stmt.where(Patient.mobility == mobility)
    if (match := contains(Patient.patient_code, q)) is not None:
        stmt = stmt.where(match)
    return paginate(db, stmt, paging, Patient.patient_code, Patient.id)


@router.get("/patients/{patient_id}", response_model=PatientOut)
def get_patient(patient_id: int, db: Db, user: Reader):
    return get_active(db, Patient, patient_id, user.organization_id, "Patient")


@router.post("/patients", response_model=PatientOut, status_code=status.HTTP_201_CREATED)
def create_patient(payload: PatientCreate, db: Db, user: Editor, request: Request):
    require_reference(db, Node, payload.node_id, user.organization_id, "Node")
    patient = Patient(organization_id=user.organization_id, **payload.model_dump())
    db.add(patient)
    flush_or_conflict(db, PATIENT_CONFLICT)
    _audit(db, user, request, "patient.created", "patient", patient.id)
    commit_or_conflict(db, PATIENT_CONFLICT)
    db.refresh(patient)
    return patient


@router.patch("/patients/{patient_id}", response_model=PatientOut)
def update_patient(patient_id: int, payload: PatientUpdate, db: Db, user: Editor, request: Request):
    patient = get_active(db, Patient, patient_id, user.organization_id, "Patient")
    changes = changes_from(
        payload, not_null={"patient_code", "mobility", "criticality", "is_synthetic"}
    )
    if changes.get("node_id") is not None:
        require_reference(db, Node, changes["node_id"], user.organization_id, "Node")
    for field, value in changes.items():
        setattr(patient, field, value)
    flush_or_conflict(db, PATIENT_CONFLICT)
    _audit(db, user, request, "patient.updated", "patient", patient.id, {"fields": sorted(changes)})
    commit_or_conflict(db, PATIENT_CONFLICT)
    db.refresh(patient)
    return patient


@router.delete("/patients/{patient_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_patient(patient_id: int, db: Db, user: Editor, request: Request):
    patient = get_active(db, Patient, patient_id, user.organization_id, "Patient")
    patient.deleted_at = func.now()
    _audit(db, user, request, "patient.deleted", "patient", patient.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Staff -----------------------------------------------------------------------------------

@router.get("/staff", response_model=Page[StaffOut])
def list_staff(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    node_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(Staff).where(
        Staff.organization_id == user.organization_id, Staff.deleted_at.is_(None)
    )
    if node_id is not None:
        stmt = stmt.where(Staff.node_id == node_id)
    matches = [m for m in (
        contains(Staff.full_name, q), contains(Staff.staff_code, q), contains(Staff.role, q)
    ) if m is not None]
    if matches:
        stmt = stmt.where(or_(*matches))
    return paginate(db, stmt, paging, Staff.full_name, Staff.id)


@router.get("/staff/{staff_id}", response_model=StaffOut)
def get_staff(staff_id: int, db: Db, user: Reader):
    return get_active(db, Staff, staff_id, user.organization_id, "Staff member")


@router.post("/staff", response_model=StaffOut, status_code=status.HTTP_201_CREATED)
def create_staff(payload: StaffCreate, db: Db, user: Editor, request: Request):
    require_reference(db, Node, payload.node_id, user.organization_id, "Node")
    member = Staff(organization_id=user.organization_id, **payload.model_dump())
    db.add(member)
    flush_or_conflict(db, STAFF_CONFLICT)
    _audit(db, user, request, "staff.created", "staff", member.id)
    commit_or_conflict(db, STAFF_CONFLICT)
    db.refresh(member)
    return member


@router.patch("/staff/{staff_id}", response_model=StaffOut)
def update_staff(staff_id: int, payload: StaffUpdate, db: Db, user: Editor, request: Request):
    member = get_active(db, Staff, staff_id, user.organization_id, "Staff member")
    changes = changes_from(
        payload, not_null={"staff_code", "full_name", "role", "is_synthetic"}
    )
    if changes.get("node_id") is not None:
        require_reference(db, Node, changes["node_id"], user.organization_id, "Node")
    for field, value in changes.items():
        setattr(member, field, value)
    flush_or_conflict(db, STAFF_CONFLICT)
    _audit(db, user, request, "staff.updated", "staff", member.id, {"fields": sorted(changes)})
    commit_or_conflict(db, STAFF_CONFLICT)
    db.refresh(member)
    return member


@router.delete("/staff/{staff_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_staff(staff_id: int, db: Db, user: Editor, request: Request):
    member = get_active(db, Staff, staff_id, user.organization_id, "Staff member")
    member.deleted_at = func.now()
    _audit(db, user, request, "staff.deleted", "staff", member.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
