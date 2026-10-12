"""Numbers used by the hazard and bottleneck models.

PROJECT.md: parameters live in the `parameters` table with unit and source;
without a real citation the source is "assumed, to be validated". Each value
below is read from that table for the organization when present; otherwise
the default is used and reported with source DEFAULT_SOURCE, so every result
shows exactly which numbers produced it.
"""

import math
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.simulation import Parameter

DEFAULT_SOURCE = "default (assumed, to be validated)"


@dataclass(frozen=True)
class ParameterSpec:
    name: str
    default: float
    unit: str
    minimum: float
    maximum: float
    meaning: str


SPECS = {
    spec.name: spec
    for spec in (
        ParameterSpec(
            "hazard_risk_horizon_minutes", 5.0, "min", 0.1, 120.0,
            "Nodes a hazard will reach within this time carry rising risk.",
        ),
        ParameterSpec(
            "hazard_risk_cost_metres", 50.0, "m", 0.0, 10_000.0,
            "Extra route cost added at full risk (risk 1.0), so routes avoid danger.",
        ),
        ParameterSpec(
            "smoke_blocking_severity", 4.0, "severity 1-5", 1.0, 6.0,
            "Smoke at this severity or higher blocks a node (6 = smoke never blocks).",
        ),
        ParameterSpec(
            "bottleneck_queue_minutes", 2.0, "min", 0.1, 120.0,
            "An edge is a bottleneck when passing everyone routed through it takes this long.",
        ),
        ParameterSpec(
            "exit_imbalance_share", 0.7, "fraction", 0.5, 1.0,
            "Recommend spreading people out when one exit gets more than this share.",
        ),
        ParameterSpec(
            "speed_ambulatory_m_per_s", 1.2, "m/s", 0.05, 5.0,
            "Walking speed of ambulatory patients and staff.",
        ),
        ParameterSpec(
            "speed_wheelchair_m_per_s", 0.8, "m/s", 0.05, 5.0,
            "Speed of wheelchair users (with or without assistance).",
        ),
        ParameterSpec(
            "speed_stretcher_m_per_s", 0.5, "m/s", 0.05, 5.0,
            "Speed of a patient moved on a stretcher or bed.",
        ),
        ParameterSpec(
            "speed_ventilator_m_per_s", 0.4, "m/s", 0.05, 5.0,
            "Speed of a ventilated patient moved with bed and equipment.",
        ),
        ParameterSpec(
            "simulation_tick_seconds", 1.0, "s", 0.1, 10.0,
            "Length of one simulation step.",
        ),
        ParameterSpec(
            "simulation_max_minutes", 60.0, "min", 1.0, 600.0,
            "The simulation stops after this much simulated time.",
        ),
        ParameterSpec(
            "simulation_frame_seconds", 5.0, "s", 1.0, 600.0,
            "How often the saved timeline records a snapshot.",
        ),
        ParameterSpec(
            "predictor_min_runs", 30.0, "runs", 10.0, 100_000.0,
            "Complete simulation runs needed before the time predictor is trained.",
        ),
        ParameterSpec(
            "priority_weight_mobility", 0.4, "weight", 0.0, 1.0,
            "Weight of mobility in the patient priority score.",
        ),
        ParameterSpec(
            "priority_weight_criticality", 0.3, "weight", 0.0, 1.0,
            "Weight of clinical criticality in the patient priority score.",
        ),
        ParameterSpec(
            "priority_weight_hazard", 0.3, "weight", 0.0, 1.0,
            "Weight of closeness to the hazard in the patient priority score.",
        ),
        ParameterSpec(
            "priority_mobility_ambulatory", 0.0, "0-1", 0.0, 1.0,
            "Mobility factor for patients who can walk.",
        ),
        ParameterSpec(
            "priority_mobility_wheelchair", 0.5, "0-1", 0.0, 1.0,
            "Mobility factor for wheelchair users.",
        ),
        ParameterSpec(
            "priority_mobility_stretcher", 0.8, "0-1", 0.0, 1.0,
            "Mobility factor for stretcher patients.",
        ),
        ParameterSpec(
            "priority_mobility_ventilator", 1.0, "0-1", 0.0, 1.0,
            "Mobility factor for ventilated patients.",
        ),
        ParameterSpec(
            "priority_hazard_distance_m", 50.0, "m", 1.0, 10_000.0,
            "Patients at the hazard get the full hazard factor; it falls to 0 at this distance.",
        ),
    )
}


@dataclass(frozen=True)
class ParameterValue:
    name: str
    value: float
    unit: str
    source: str
    meaning: str


def load_parameters(db: Session, organization_id: int, names: list[str]) -> dict[str, ParameterValue]:
    rows = {
        row.name: row for row in db.scalars(
            select(Parameter).where(
                Parameter.organization_id == organization_id,
                Parameter.name.in_(names),
                Parameter.deleted_at.is_(None),
            )
        )
    }
    values = {}
    for name in names:
        spec = SPECS[name]
        row = rows.get(name)
        if row is None:
            values[name] = ParameterValue(name, spec.default, spec.unit, DEFAULT_SOURCE, spec.meaning)
            continue
        try:
            number = float(row.value)
        except ValueError:
            number = math.nan
        if not math.isfinite(number) or not spec.minimum <= number <= spec.maximum:
            raise HTTPException(
                status_code=422,
                detail=f"Parameter {name} must be a number between {spec.minimum:g} and "
                f"{spec.maximum:g} ({spec.unit}); fix it in Settings",
            )
        values[name] = ParameterValue(name, number, row.unit or spec.unit, row.source, spec.meaning)
    return values
