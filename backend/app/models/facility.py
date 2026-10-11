from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, TenantMixin, TimestampMixin


class Hospital(TenantMixin, TimestampMixin, Base):
    __tablename__ = "hospitals"
    __table_args__ = (
        UniqueConstraint("organization_id", "name", name="uq_hospital_org_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(String(500))
    timezone: Mapped[str] = mapped_column(String(100), default="Asia/Kolkata", nullable=False)

    buildings: Mapped[list["Building"]] = relationship(back_populates="hospital")


class Building(TenantMixin, TimestampMixin, Base):
    __tablename__ = "buildings"
    __table_args__ = (
        UniqueConstraint("hospital_id", "name", name="uq_building_hospital_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(
        ForeignKey("hospitals.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))

    hospital: Mapped["Hospital"] = relationship(back_populates="buildings")
    floors: Mapped[list["Floor"]] = relationship(back_populates="building")


class Floor(TenantMixin, TimestampMixin, Base):
    __tablename__ = "floors"
    __table_args__ = (
        UniqueConstraint("building_id", "floor_number", name="uq_floor_building_number"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(
        ForeignKey("buildings.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    floor_number: Mapped[int] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    elevation_metres: Mapped[float | None]

    building: Mapped["Building"] = relationship(back_populates="floors")
