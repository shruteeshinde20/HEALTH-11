
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db_session import get_db
from app.models.facility import Building, Floor, Hospital
from app.models.user import User


router = APIRouter(prefix="/facilities", tags=["Facilities"])

Db = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


# Request schemas

class HospitalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    timezone: str = Field(default="Asia/Kolkata", max_length=100)


class BuildingCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=500)


class FloorCreate(BaseModel):
    floor_number: int
    name: str = Field(min_length=1, max_length=100)
    elevation_metres: float | None = None


# Response schemas

class HospitalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    name: str
    address: str | None
    timezone: str


class BuildingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    hospital_id: int
    name: str
    description: str | None


class FloorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    organization_id: int
    building_id: int
    floor_number: int
    name: str
    elevation_metres: float | None


# Authorization and database helpers

def _require_admin(user: User) -> None:
    role = getattr(user.role, "value", user.role)
    if role != "administrator":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator role required",
        )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A conflicting facility record already exists",
        ) from exc


def _hospital(db: Session, hospital_id: int, org_id: int) -> Hospital:
    item = db.scalar(
        select(Hospital).where(
            Hospital.id == hospital_id,
            Hospital.organization_id == org_id,
            Hospital.deleted_at.is_(None),
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return item


def _building(db: Session, building_id: int, org_id: int) -> Building:
    item = db.scalar(
        select(Building).where(
            Building.id == building_id,
            Building.organization_id == org_id,
            Building.deleted_at.is_(None),
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Building not found")
    return item


# Hospitals

@router.post(
    "/hospitals",
    response_model=HospitalOut,
    status_code=status.HTTP_201_CREATED,
)
def create_hospital(
    payload: HospitalCreate,
    db: Db,
    user: CurrentUser,
) -> Hospital:
    _require_admin(user)

    hospital = Hospital(
        organization_id=user.organization_id,
        **payload.model_dump(),
    )
    db.add(hospital)
    _commit(db)
    db.refresh(hospital)
    return hospital


@router.get("/hospitals", response_model=list[HospitalOut])
def list_hospitals(db: Db, user: CurrentUser) -> list[Hospital]:
    return list(
        db.scalars(
            select(Hospital)
            .where(
                Hospital.organization_id == user.organization_id,
                Hospital.deleted_at.is_(None),
            )
            .order_by(Hospital.id)
        ).all()
    )


# Buildings

@router.post(
    "/hospitals/{hospital_id}/buildings",
    response_model=BuildingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_building(
    hospital_id: int,
    payload: BuildingCreate,
    db: Db,
    user: CurrentUser,
) -> Building:
    _require_admin(user)
    _hospital(db, hospital_id, user.organization_id)

    building = Building(
        organization_id=user.organization_id,
        hospital_id=hospital_id,
        **payload.model_dump(),
    )
    db.add(building)
    _commit(db)
    db.refresh(building)
    return building


@router.get(
    "/hospitals/{hospital_id}/buildings",
    response_model=list[BuildingOut],
)
def list_buildings(
    hospital_id: int,
    db: Db,
    user: CurrentUser,
) -> list[Building]:
    _hospital(db, hospital_id, user.organization_id)
    return list(
        db.scalars(
            select(Building)
            .where(
                Building.hospital_id == hospital_id,
                Building.organization_id == user.organization_id,
                Building.deleted_at.is_(None),
            )
            .order_by(Building.id)
        ).all()
    )


# Floors

@router.post(
    "/buildings/{building_id}/floors",
    response_model=FloorOut,
    status_code=status.HTTP_201_CREATED,
)
def create_floor(
    building_id: int,
    payload: FloorCreate,
    db: Db,
    user: CurrentUser,
) -> Floor:
    _require_admin(user)
    _building(db, building_id, user.organization_id)

    floor = Floor(
        organization_id=user.organization_id,
        building_id=building_id,
        **payload.model_dump(),
    )
    db.add(floor)
    _commit(db)
    db.refresh(floor)
    return floor


@router.get(
    "/buildings/{building_id}/floors",
    response_model=list[FloorOut],
)
def list_floors(
    building_id: int,
    db: Db,
    user: CurrentUser,
) -> list[Floor]:
    _building(db, building_id, user.organization_id)
    return list(
        db.scalars(
            select(Floor)
            .where(
                Floor.building_id == building_id,
                Floor.organization_id == user.organization_id,
                Floor.deleted_at.is_(None),
            )
            .order_by(Floor.floor_number)
        ).all()
    )
