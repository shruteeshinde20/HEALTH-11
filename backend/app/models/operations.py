import enum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    Float,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TenantMixin, TimestampMixin

ACTIVE = text("deleted_at IS NULL")


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
        ForeignKeyConstraint(
            ["organization_id", "node_id"],
            ["nodes.organization_id", "nodes.id"],
            name="fk_patients_node", ondelete="RESTRICT",
        ),
        Index(
            "uq_patient_org_code", "organization_id", "patient_code",
            unique=True, postgresql_where=ACTIVE,
        ),
        CheckConstraint("criticality >= 1 AND criticality <= 5", name="ck_patient_criticality_range"),
        Index("ix_patient_org_node", "organization_id", "node_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_code: Mapped[str] = mapped_column(String(100), nullable=False)
    mobility: Mapped[PatientMobility] = mapped_column(
        Enum(PatientMobility, name="patient_mobility", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    criticality: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    node_id: Mapped[int | None] = mapped_column(nullable=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Staff(TenantMixin, TimestampMixin, Base):
    __tablename__ = "staff"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id", "node_id"],
            ["nodes.organization_id", "nodes.id"],
            name="fk_staff_node", ondelete="RESTRICT",
        ),
        Index(
            "uq_staff_org_code", "organization_id", "staff_code",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_code: Mapped[str] = mapped_column(String(100), nullable=False)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(100), nullable=False)
    node_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Hazard(TenantMixin, TimestampMixin, Base):
    __tablename__ = "hazards"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id", "scenario_id"],
            ["scenarios.organization_id", "scenarios.id"],
            name="fk_hazards_scenario", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["organization_id", "origin_node_id"],
            ["nodes.organization_id", "nodes.id"],
            name="fk_hazards_origin_node", ondelete="RESTRICT",
        ),
        CheckConstraint("spread_rate >= 0", name="ck_hazard_spread_nonnegative"),
        CheckConstraint("severity >= 1 AND severity <= 5", name="ck_hazard_severity_range"),
        Index("ix_hazard_org_origin", "organization_id", "origin_node_id"),
        Index("ix_hazard_org_scenario", "organization_id", "scenario_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scenario_id: Mapped[int] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[HazardType] = mapped_column(
        Enum(HazardType, name="hazard_type", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    origin_node_id: Mapped[int] = mapped_column(nullable=False)
    spread_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    severity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Scenario(TenantMixin, TimestampMixin, Base):
    __tablename__ = "scenarios"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_scenarios_org_id"),
        ForeignKeyConstraint(
            ["organization_id", "created_by_user_id"],
            ["users.organization_id", "users.id"],
            name="fk_scenarios_created_by", ondelete="RESTRICT",
        ),
        Index(
            "uq_scenario_org_name", "organization_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
