"""AI endpoints (PROJECT.md AI features 1, 2 and 5).

- POST /predict {scenario_id, building_id?, algorithm?}
    -> {predicted_time_s, method, mae, r2, note, about}
    predicted_time_s is null with a note when there is not enough data.
- GET /alerts -> {message?, alerts: [{run_id, reason, kind}], method}
- GET /patient_priority?scenario_id=&building_id= -> ranked patients with
    the full score breakdown.

Every answer says how it was produced and how accurate it is ("About this
prediction"); nothing is invented when data is missing.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_common import Id, PageParams, page_params, require_reference
from app.config import get_settings
from app.db_session import get_db
from app.models.facility import Building
from app.models.graph import Node
from app.models.operations import Patient, Scenario
from app.models.simulation import MLModel, SimulationRun
from app.permissions import Editor, Reader
from app.services import ml, priority
from app.services import simulation_runner as runner
from app.services.model_parameters import load_parameters
from app.services.scenario_inputs import building_nodes_and_edges, scenario_hazards

router = APIRouter(tags=["AI"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

PRIORITY_PARAMETERS = [
    "priority_weight_mobility", "priority_weight_criticality", "priority_weight_hazard",
    "priority_mobility_ambulatory", "priority_mobility_wheelchair",
    "priority_mobility_stretcher", "priority_mobility_ventilator",
    "priority_hazard_distance_m",
]


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: Id
    building_id: Id | None = None
    algorithm: Annotated[str, Field(pattern="^(bfs|dfs|dijkstra|astar)$")] = "astar"


def _completed_runs(db: Session, organization_id: int, limit: int | None = None):
    stmt = select(SimulationRun).where(
        SimulationRun.organization_id == organization_id,
        SimulationRun.deleted_at.is_(None),
        SimulationRun.status == "completed",
    ).order_by(SimulationRun.id.desc())
    if limit:
        stmt = stmt.limit(limit)
    return list(reversed(db.scalars(stmt).all()))


def run_features(run: SimulationRun) -> dict[str, float]:
    cached = (run.params or {}).get("features")
    if cached and set(cached) == set(ml.FEATURES):
        return cached
    params = run.params
    return ml.features(params["snapshot"], params.get("injected_hazards", []),
                       run.algorithm, params["values"])


def _answer(predicted, note, metrics=None, about=None):
    return {
        "predicted_time_s": predicted,
        "method": ml.METHOD_PREDICTOR,
        "mae": metrics.get("mae_s") if metrics else None,
        "r2": metrics.get("r2") if metrics else None,
        "note": note,
        "about": about,
    }


@router.post("/predict")
def predict(payload: PredictRequest, db: Db, user: Editor):
    org = user.organization_id
    require_reference(db, Scenario, payload.scenario_id, org, "Scenario")
    building_id = payload.building_id
    if building_id is None:
        building_id = runner.building_for_scenario(db, org, payload.scenario_id)
    else:
        require_reference(db, Building, building_id, org, "Building")

    params = runner.parameters(db, org)
    values = {name: p.value for name, p in params.items()}
    min_runs = int(load_parameters(db, org, ["predictor_min_runs"])["predictor_min_runs"].value)
    snapshot = runner.take_snapshot(db, org, payload.scenario_id, building_id)
    row = ml.features(snapshot, [], payload.algorithm, values)

    if not row["people_total"]:
        return _answer(None, "Nobody is placed in this building, so there is nothing to predict.")
    if row["people_without_route"]:
        return _answer(None, f"{int(row['people_without_route'])} people have no safe route at the "
                             "start, so there is no complete evacuation time to predict.")

    eligible = [r for r in _completed_runs(db, org)
                if (r.results or {}).get("summary", {}).get("all_evacuated")]
    if len(eligible) < min_runs:
        return _answer(None, f"Not enough data: {len(eligible)} complete simulation runs; at least "
                             f"{min_runs} are needed to train and test the predictor. Run more "
                             "simulations (different scenarios, people and settings).")

    signature = {"runs": len(eligible), "last_run_id": eligible[-1].id}
    settings = get_settings()
    record = db.scalar(select(MLModel).where(
        MLModel.organization_id == org, MLModel.model_type == ml.PREDICTOR_TYPE,
        MLModel.deleted_at.is_(None)).order_by(MLModel.id.desc()).limit(1))
    model = None
    if record and (record.metrics or {}).get("signature") == signature and record.file_path:
        model = ml.load_model(settings.model_dir, record.file_path)
    if model is None:
        rows = [run_features(r) for r in eligible]
        targets = [r.results["summary"]["evacuation_time_s"] for r in eligible]
        model, metrics = ml.train_predictor(rows, targets)
        record = MLModel(organization_id=org, model_type=ml.PREDICTOR_TYPE,
                         metrics={**metrics, "signature": signature}, trained_at=ml.utc_now())
        db.add(record)
        db.flush()
        path = ml.model_path(settings.model_dir, org, record.id)
        ml.save_model(model, path)
        record.file_path = str(path)
        db.commit()

    metrics = record.metrics
    predicted = round(ml.predict(model, row), 1)
    if metrics["r2"] is None or metrics["mae_s"] >= metrics["baseline_mae_s"]:
        note = (f"On runs held out from training the model was not more accurate than always "
                f"guessing the average time (error {metrics['mae_s']:.0f} s vs "
                f"{metrics['baseline_mae_s']:.0f} s). Treat this estimate with caution, or run "
                "the full simulation.")
    else:
        note = (f"Typical error on runs held out from training: about {metrics['mae_s']:.0f} s "
                f"(always guessing the average would be off by {metrics['baseline_mae_s']:.0f} s). "
                "This is an estimate of the simulator's result, not of a real evacuation.")
    about = {
        "model_id": record.id,
        "trained_at": record.trained_at.isoformat() if record.trained_at else None,
        "training_runs": metrics["training_runs"],
        "test_runs": metrics["test_runs"],
        "baseline_mae_s": metrics["baseline_mae_s"],
        "model": metrics["algorithm"],
        "features": metrics["features"],
        "parameters_used": runner.parameters_used(params),
    }
    return _answer(predicted, note, metrics, about)


@router.get("/alerts")
def alerts(db: Db, user: Reader):
    runs = _completed_runs(db, user.organization_id, limit=1000)
    found, message = [], None
    if len(runs) < ml.ALERTS_MIN_RUNS:
        message = (f"More data needed: unusual-run detection needs at least {ml.ALERTS_MIN_RUNS} "
                   f"simulation runs; there are {len(runs)}.")
    else:
        for item in ml.anomalies([(r.id, ml.alert_features(r.results)) for r in runs]):
            found.append({"run_id": item["run_id"], "reason": item["reason"], "kind": "anomaly"})

    for run in reversed(runs[-20:]):
        summary = run.results.get("summary", {})
        left = summary.get("needs_assistance", 0) + summary.get("reached_by_hazard", 0)
        if left:
            found.append({"run_id": run.id, "kind": "safety", "reason":
                          f"{left} of {summary.get('total', 0)} people were not evacuated "
                          "(needed assistance or were reached by the hazard)."})
        for bottleneck in run.results.get("bottlenecks", [])[:3]:
            found.append({"run_id": run.id, "kind": "bottleneck", "reason":
                          f"Bottleneck at {bottleneck['label']} ({', '.join(bottleneck['reasons'])})."})
    return {"message": message, "alerts": found, "method": ml.METHOD_ALERTS,
            "runs_considered": len(runs)}


@router.get("/patient_priority")
def patient_priority(
    db: Db, user: Reader, paging: Paging,
    scenario_id: Annotated[int | None, Query(gt=0)] = None,
    building_id: Annotated[int | None, Query(gt=0)] = None,
):
    org = user.organization_id
    values_by_name = load_parameters(db, org, PRIORITY_PARAMETERS)
    values = {name: p.value for name, p in values_by_name.items()}
    if not sum(values[f"priority_weight_{k}"] for k in ("mobility", "criticality", "hazard")):
        raise HTTPException(status_code=422, detail="At least one priority weight must be above 0")

    if scenario_id is not None:
        require_reference(db, Scenario, scenario_id, org, "Scenario")
        if building_id is None:
            building_id = runner.building_for_scenario(db, org, scenario_id)
    if building_id is not None:
        require_reference(db, Building, building_id, org, "Building")
        nodes, edges = building_nodes_and_edges(db, building_id, org)
        patients = db.scalars(select(Patient).where(
            Patient.organization_id == org, Patient.deleted_at.is_(None),
            Patient.node_id.in_([n.id for n in nodes]))).all() if nodes else []
    else:
        nodes, edges = [], []
        patients = db.scalars(select(Patient).where(
            Patient.organization_id == org, Patient.deleted_at.is_(None))).all()
        node_ids = {p.node_id for p in patients if p.node_id is not None}
        if node_ids:
            nodes = db.scalars(select(Node).where(Node.organization_id == org,
                                                  Node.id.in_(node_ids))).all()

    hazards = scenario_hazards(db, scenario_id, org) if scenario_id is not None else []
    rows = priority.score_patients(patients, nodes, edges, hazards, values,
                                   has_scenario=scenario_id is not None)
    return {
        "items": rows[paging.offset: paging.offset + paging.limit],
        "total": len(rows),
        "limit": paging.limit,
        "offset": paging.offset,
        "scenario_id": scenario_id,
        "building_id": building_id,
        "method": priority.METHOD,
        "parameters_used": [
            {"name": p.name, "value": p.value, "unit": p.unit, "source": p.source, "meaning": p.meaning}
            for p in values_by_name.values()
        ],
    }
