from datetime import datetime
from typing import Any

from sqlalchemy import (
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TenantMixin, TimestampMixin

ACTIVE = text("deleted_at IS NULL")


class SimulationRun(TenantMixin, TimestampMixin, Base):
    __tablename__ = "simulation_runs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id", "scenario_id"],
            ["scenarios.organization_id", "scenarios.id"],
            name="fk_simulation_runs_scenario", ondelete="RESTRICT",
        ),
        Index("ix_simulation_run_org_scenario", "organization_id", "scenario_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scenario_id: Mapped[int] = mapped_column(nullable=False)
    algorithm: Mapped[str] = mapped_column(String(100), nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    results: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")


class EvacuationPlan(TenantMixin, TimestampMixin, Base):
    __tablename__ = "evacuation_plans"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id", "scenario_id"],
            ["scenarios.organization_id", "scenarios.id"],
            name="fk_evacuation_plans_scenario", ondelete="RESTRICT",
        ),
        Index(
            "uq_evacuation_plan_org_name", "organization_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scenario_id: Mapped[int] = mapped_column(nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    routes: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft")


class Parameter(TenantMixin, TimestampMixin, Base):
    __tablename__ = "parameters"
    __table_args__ = (
        Index(
            "uq_parameter_org_name", "organization_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source: Mapped[str] = mapped_column(String(300), nullable=False)


class AuditLog(TenantMixin, TimestampMixin, Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_org_created", "organization_id", "created_at"),
        Index("ix_audit_log_entity", "entity_type", "entity_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)


class MLModel(TenantMixin, TimestampMixin, Base):
    __tablename__ = "ml_models"

    id: Mapped[int] = mapped_column(primary_key=True)
    model_type: Mapped[str] = mapped_column("type", String(100), nullable=False)
    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    trained_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    file_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
