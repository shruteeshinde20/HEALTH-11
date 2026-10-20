"""Hospitals, buildings and floors (PROJECT.md API contract).

GET list, GET /{id}, POST, PATCH /{id}, DELETE /{id} (soft delete).
Reads: any signed-in user. Writes: Administrator or Emergency Commander.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_common import (
    FiniteFloat,
    Id,
    Name,
    OptionalText,
    Page,
    PageParams,
    SearchQuery,
    TimeZoneName,
    changes_from,
    commit_or_conflict,
    contains,
    ensure_none_active,
    flush_or_conflict,
    get_active,
    page_params,
    paginate,
    require_reference,
    soft_delete,
)
from app.audit import record_audit
from app.db_session import get_db
from app.models.facility import Building, Floor, Hospital
from app.models.graph import Node
from app.permissions import Editor, Reader

router = APIRouter(tags=["Facilities"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

HOSPITAL_CONFLICT = "A hospital with this name already exists"
BUILDING_CONFLICT = "A building with this name already exists in this hospital"
FLOOR_CONFLICT = "This floor number already exists in this building"


# --- Schemas ------------------------------------------------------------------------

# Map position in decimal degrees (WGS 84), as map apps show it.
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
LOCATION_PAIR = "Give both latitude and longitude, or neither"


class HospitalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200)
    address: OptionalText(500) = None
    timezone: TimeZoneName
    latitude: Latitude | None = None
    longitude: Longitude | None = None

    @model_validator(mode="after")
    def location_pair(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError(LOCATION_PAIR)
        return self


class HospitalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200) | None = None
    address: OptionalText(500) = None
    timezone: TimeZoneName | None = None
    # null clears the position (send both as null).
    latitude: Latitude | None = None
    longitude: Longitude | None = None


class HospitalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    name: str
    address: str | None
    timezone: str
    latitude: float | None
    longitude: float | None
    created_at: datetime
    updated_at: datetime


class BuildingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hospital_id: Id
    name: Name(200)
    description: OptionalText(500) = None


class BuildingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(200) | None = None
    description: OptionalText(500) = None


class BuildingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    hospital_id: int
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime


FloorNumber = Annotated[int, Field(ge=-20, le=300)]


class FloorCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    building_id: Id
    floor_number: FloorNumber
    name: Name(100)
    elevation_metres: FiniteFloat | None = None


class FloorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    floor_number: FloorNumber | None = None
    name: Name(100) | None = None
    elevation_metres: FiniteFloat | None = None


class FloorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    building_id: int
    floor_number: int
    name: str
    elevation_metres: float | None
    created_at: datetime
    updated_at: datetime


def _audit(db, user, request, action, entity_type, entity_id, details=None):
    record_audit(
        db, organization_id=user.organization_id, actor_user_id=user.id,
        action=action, entity_type=entity_type, entity_id=entity_id,
        request=request, details=details,
    )


# --- Hospitals --------------------------------------------------------------------------

@router.get("/hospitals", response_model=Page[HospitalOut])
def list_hospitals(db: Db, user: Reader, paging: Paging, q: SearchQuery = None):
    stmt = select(Hospital).where(
        Hospital.organization_id == user.organization_id, Hospital.deleted_at.is_(None)
    )
    if (match := contains(Hospital.name, q)) is not None:
        stmt = stmt.where(match)
    return paginate(db, stmt, paging, Hospital.name, Hospital.id)


@router.get("/hospitals/{hospital_id}", response_model=HospitalOut)
def get_hospital(hospital_id: int, db: Db, user: Reader):
    return get_active(db, Hospital, hospital_id, user.organization_id, "Hospital")


@router.post("/hospitals", response_model=HospitalOut, status_code=status.HTTP_201_CREATED)
def create_hospital(payload: HospitalCreate, db: Db, user: Editor, request: Request):
    hospital = Hospital(organization_id=user.organization_id, **payload.model_dump())
    db.add(hospital)
    flush_or_conflict(db, HOSPITAL_CONFLICT)
    _audit(db, user, request, "hospital.created", "hospital", hospital.id)
    commit_or_conflict(db, HOSPITAL_CONFLICT)
    db.refresh(hospital)
    return hospital


@router.patch("/hospitals/{hospital_id}", response_model=HospitalOut)
def update_hospital(hospital_id: int, payload: HospitalUpdate, db: Db, user: Editor, request: Request):
    hospital = get_active(db, Hospital, hospital_id, user.organization_id, "Hospital")
    changes = changes_from(payload, not_null={"name", "timezone"})
    latitude = changes.get("latitude", hospital.latitude)
    longitude = changes.get("longitude", hospital.longitude)
    if (latitude is None) != (longitude is None):
        raise HTTPException(status_code=422, detail=LOCATION_PAIR)
    for field, value in changes.items():
        setattr(hospital, field, value)
    flush_or_conflict(db, HOSPITAL_CONFLICT)
    _audit(db, user, request, "hospital.updated", "hospital", hospital.id, {"fields": sorted(changes)})
    commit_or_conflict(db, HOSPITAL_CONFLICT)
    db.refresh(hospital)
    return hospital


@router.delete("/hospitals/{hospital_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_hospital(hospital_id: int, db: Db, user: Editor, request: Request):
    hospital = get_active(db, Hospital, hospital_id, user.organization_id, "Hospital")
    ensure_none_active(
        db, Building, Building.hospital_id == hospital.id,
        "Delete this hospital's buildings first",
    )
    soft_delete(hospital)
    _audit(db, user, request, "hospital.deleted", "hospital", hospital.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Buildings ---------------------------------------------------------------------------

@router.get("/buildings", response_model=Page[BuildingOut])
def list_buildings(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    hospital_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(Building).where(
        Building.organization_id == user.organization_id, Building.deleted_at.is_(None)
    )
    if hospital_id is not None:
        stmt = stmt.where(Building.hospital_id == hospital_id)
    if (match := contains(Building.name, q)) is not None:
        stmt = stmt.where(match)
    return paginate(db, stmt, paging, Building.name, Building.id)


@router.get("/buildings/{building_id}", response_model=BuildingOut)
def get_building(building_id: int, db: Db, user: Reader):
    return get_active(db, Building, building_id, user.organization_id, "Building")


@router.post("/buildings", response_model=BuildingOut, status_code=status.HTTP_201_CREATED)
def create_building(payload: BuildingCreate, db: Db, user: Editor, request: Request):
    require_reference(db, Hospital, payload.hospital_id, user.organization_id, "Hospital")
    building = Building(organization_id=user.organization_id, **payload.model_dump())
    db.add(building)
    flush_or_conflict(db, BUILDING_CONFLICT)
    _audit(db, user, request, "building.created", "building", building.id,
           {"hospital_id": building.hospital_id})
    commit_or_conflict(db, BUILDING_CONFLICT)
    db.refresh(building)
    return building


@router.patch("/buildings/{building_id}", response_model=BuildingOut)
def update_building(building_id: int, payload: BuildingUpdate, db: Db, user: Editor, request: Request):
    building = get_active(db, Building, building_id, user.organization_id, "Building")
    changes = changes_from(payload, not_null={"name"})
    for field, value in changes.items():
        setattr(building, field, value)
    flush_or_conflict(db, BUILDING_CONFLICT)
    _audit(db, user, request, "building.updated", "building", building.id, {"fields": sorted(changes)})
    commit_or_conflict(db, BUILDING_CONFLICT)
    db.refresh(building)
    return building


@router.delete("/buildings/{building_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_building(building_id: int, db: Db, user: Editor, request: Request):
    building = get_active(db, Building, building_id, user.organization_id, "Building")
    ensure_none_active(
        db, Floor, Floor.building_id == building.id, "Delete this building's floors first",
    )
    soft_delete(building)
    _audit(db, user, request, "building.deleted", "building", building.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Floors ---------------------------------------------------------------------------------

@router.get("/floors", response_model=Page[FloorOut])
def list_floors(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    building_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(Floor).where(
        Floor.organization_id == user.organization_id, Floor.deleted_at.is_(None)
    )
    if building_id is not None:
        stmt = stmt.where(Floor.building_id == building_id)
    if (match := contains(Floor.name, q)) is not None:
        stmt = stmt.where(match)
    return paginate(db, stmt, paging, Floor.building_id, Floor.floor_number, Floor.id)


@router.get("/floors/{floor_id}", response_model=FloorOut)
def get_floor(floor_id: int, db: Db, user: Reader):
    return get_active(db, Floor, floor_id, user.organization_id, "Floor")


@router.post("/floors", response_model=FloorOut, status_code=status.HTTP_201_CREATED)
def create_floor(payload: FloorCreate, db: Db, user: Editor, request: Request):
    require_reference(db, Building, payload.building_id, user.organization_id, "Building")
    floor = Floor(organization_id=user.organization_id, **payload.model_dump())
    db.add(floor)
    flush_or_conflict(db, FLOOR_CONFLICT)
    _audit(db, user, request, "floor.created", "floor", floor.id, {"building_id": floor.building_id})
    commit_or_conflict(db, FLOOR_CONFLICT)
    db.refresh(floor)
    return floor


@router.patch("/floors/{floor_id}", response_model=FloorOut)
def update_floor(floor_id: int, payload: FloorUpdate, db: Db, user: Editor, request: Request):
    floor = get_active(db, Floor, floor_id, user.organization_id, "Floor")
    changes = changes_from(payload, not_null={"floor_number", "name"})
    for field, value in changes.items():
        setattr(floor, field, value)
    flush_or_conflict(db, FLOOR_CONFLICT)
    _audit(db, user, request, "floor.updated", "floor", floor.id, {"fields": sorted(changes)})
    commit_or_conflict(db, FLOOR_CONFLICT)
    db.refresh(floor)
    return floor


@router.delete("/floors/{floor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_floor(floor_id: int, db: Db, user: Editor, request: Request):
    floor = get_active(db, Floor, floor_id, user.organization_id, "Floor")
    ensure_none_active(db, Node, Node.floor_id == floor.id, "Delete this floor's nodes first")
    soft_delete(floor)
    _audit(db, user, request, "floor.deleted", "floor", floor.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
