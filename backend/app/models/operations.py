import enum

from sqlalchemy import Boolean, CheckConstraint, Enum, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TenantMixin, TimestampMixin


class PatientMobility(str, enum.Enum):
    AMBULATORY = "ambulatory"
    WHEELCHAIR = "wheelchair"
    STRETCHER = "stretcher"
    VENTILATOR = "ventilator"


class HazardType(str, enum.Enum):
    FIRE = "fire"
    SMOKE = "smoke"
    HAZMAT = "hazmat"
    STRUCTURAL = "structural"


class Patient(TenantMixin, TimestampMixin, Base):
    __tablename__ = "patients"
    __table_args__ = (
        CheckConstraint("criticality >= 1 AND criticality <= 5", name="ck_patient_criticality_range"),
        Index("ix_patient_org_node", "organization_id", "node_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_code: Mapped[str] = mapped_column(String(100), nullable=False)
    mobility: Mapped[PatientMobility] = mapped_column(
        Enum(PatientMobility, name="patient_mobility", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    criticality: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    node_id: Mapped[int | None] = mapped_column(
        ForeignKey("nodes.id", ondelete="RESTRICT"), nullable=True
    )
    is_synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Staff(TenantMixin, TimestampMixin, Base):
    __tablename__ = "staff"
    __table_args__ = (
        UniqueConstraint("organization_id", "staff_code", name="uq_staff_org_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_code: Mapped[str] = mapped_column(String(100), nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(100), nullable=False)
    node_id: Mapped[int | None] = mapped_column(
        ForeignKey("nodes.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    is_synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Hazard(TenantMixin, TimestampMixin, Base):
    __tablename__ = "hazards"
    __table_args__ = (
        CheckConstraint("spread_rate >= 0", name="ck_hazard_spread_nonnegative"),
        CheckConstraint("severity >= 1 AND severity <= 5", name="ck_hazard_severity_range"),
        Index("ix_hazard_org_origin", "organization_id", "origin_node_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[HazardType] = mapped_column(
        Enum(HazardType, name="hazard_type", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    origin_node_id: Mapped[int] = mapped_column(
        ForeignKey("nodes.id", ondelete="RESTRICT"), nullable=False
    )
    spread_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    severity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Scenario(TenantMixin, TimestampMixin, Base):
    __tablename__ = "scenarios"
    __table_args__ = (
        UniqueConstraint("organization_id", "name", name="uq_scenario_org_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
