from sqlalchemy import CheckConstraint, Float, ForeignKeyConstraint, Index, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, TenantMixin, TimestampMixin

# Child rows reference their parent with (organization_id, parent_id), so the
# database itself rejects links between different organizations.
ACTIVE = text("deleted_at IS NULL")


class Hospital(TenantMixin, TimestampMixin, Base):
    __tablename__ = "hospitals"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_hospitals_org_id"),
        Index(
            "uq_hospital_org_name", "organization_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
        # Map position in decimal degrees (WGS 84), both or neither.
        CheckConstraint("latitude IS NULL OR (latitude >= -90 AND latitude <= 90)",
                        name="ck_hospital_latitude_range"),
        CheckConstraint("longitude IS NULL OR (longitude >= -180 AND longitude <= 180)",
                        name="ck_hospital_longitude_range"),
        CheckConstraint("(latitude IS NULL) = (longitude IS NULL)", name="ck_hospital_location_pair"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(String(500))
    timezone: Mapped[str] = mapped_column(String(100), default="UTC", server_default="UTC", nullable=False)
    # Where the hospital is (decimal degrees, WGS 84). Optional; the outside
    # data sources (map, weather, official alerts) need it.
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)

    buildings: Mapped[list["Building"]] = relationship(
        primaryjoin="and_(Hospital.id == foreign(Building.hospital_id), "
        "Hospital.organization_id == foreign(Building.organization_id))",
        viewonly=True,
    )


class Building(TenantMixin, TimestampMixin, Base):
    __tablename__ = "buildings"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_buildings_org_id"),
        ForeignKeyConstraint(
            ["organization_id", "hospital_id"],
            ["hospitals.organization_id", "hospitals.id"],
            name="fk_buildings_hospital", ondelete="RESTRICT",
        ),
        Index(
            "uq_building_hospital_name", "hospital_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))

    hospital: Mapped["Hospital"] = relationship(
        primaryjoin="and_(Hospital.id == foreign(Building.hospital_id), "
        "Hospital.organization_id == foreign(Building.organization_id))",
        viewonly=True,
    )
    floors: Mapped[list["Floor"]] = relationship(
        primaryjoin="and_(Building.id == foreign(Floor.building_id), "
        "Building.organization_id == foreign(Floor.organization_id))",
        viewonly=True,
    )


class Floor(TenantMixin, TimestampMixin, Base):
    __tablename__ = "floors"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_floors_org_id"),
        ForeignKeyConstraint(
            ["organization_id", "building_id"],
            ["buildings.organization_id", "buildings.id"],
            name="fk_floors_building", ondelete="RESTRICT",
        ),
        Index(
            "uq_floor_building_number", "building_id", "floor_number",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(nullable=False, index=True)
    floor_number: Mapped[int] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    elevation_metres: Mapped[float | None]

    building: Mapped["Building"] = relationship(
        primaryjoin="and_(Building.id == foreign(Floor.building_id), "
        "Building.organization_id == foreign(Floor.organization_id))",
        viewonly=True,
    )
