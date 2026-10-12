"""Machine-learning features (PROJECT.md AI features 1 and 5).

AI feature 1: evacuation-time predictor
- A scikit-learn random-forest regression trained on the organization's own
  saved simulation runs. It is a surrogate for the simulator: it estimates
  what the simulator would report, quickly, without running it. It knows
  nothing about real evacuations beyond what the simulator models.
- Only runs where everyone was evacuated have an evacuation time, so only
  those are used for training.
- Accuracy: 25% of the runs are held out and never used for training; MAE
  and R2 are measured on them, together with the MAE of always guessing the
  average time (baseline), so users can see whether the model helps at all.
- Below `predictor_min_runs` complete runs, nothing is predicted.

AI feature 5: anomaly alerts
- scikit-learn IsolationForest on three features of past runs: evacuation
  time (or simulated time when incomplete), the highest planned queue on any
  corridor and the number of blocked nodes at the end. Needs at least 50
  runs (PROJECT.md); below that it reports "more data needed".
"""

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from app.services.hazards import hazard_context
from app.services.routing import InvalidRouteRequest, NoRouteError, nearest_safe_exit

PREDICTOR_TYPE = "evacuation_time_predictor"
ALERTS_MIN_RUNS = 50  # PROJECT.md: below 50 runs show "more data needed"
RANDOM_STATE = 20261012
MOBILITIES = ("ambulatory", "wheelchair", "stretcher", "ventilator")
ALGORITHMS = ("bfs", "dfs", "dijkstra", "astar")

FEATURES = (
    ["people_total"] + [f"people_{m}" for m in MOBILITIES]
    + ["nodes", "edges", "exits", "total_edge_length_m", "min_max_flow", "mean_max_flow",
       "hazards", "max_severity", "max_spread_rate", "fire_or_smoke"]
    + [f"speed_{m}" for m in MOBILITIES]
    + [f"algorithm_{a}" for a in ALGORITHMS]
    + ["mean_route_m", "max_route_m", "people_without_route"]
)

METHOD_PREDICTOR = (
    "Random-forest regression (scikit-learn) trained on your organization's own complete "
    "simulation runs. It estimates what the simulator would report; it is not a measurement "
    "of real evacuations. Accuracy is measured on runs held out from training."
)
METHOD_ALERTS = (
    "IsolationForest (scikit-learn) on evacuation time, highest planned corridor queue and "
    "blocked nodes of past runs flags unusual runs; the bottleneck detector adds runs with "
    "bottlenecks or people left behind."
)


def _ns(rows):
    return [SimpleNamespace(**row) for row in rows]


def features(snapshot: dict, injected: list[dict], algorithm: str, values: dict) -> dict[str, float]:
    """Numbers describing one simulation input (known before simulating)."""
    nodes, edges = _ns(snapshot["nodes"]), _ns(snapshot["edges"])
    hazards = [h for h in snapshot["hazards"] + injected if h.get("is_active", True)]
    agents = snapshot["agents"]
    row: dict[str, float] = {"people_total": len(agents)}
    for mobility in MOBILITIES:
        row[f"people_{mobility}"] = sum(1 for a in agents if a["mobility"] == mobility)
    flows = [e.max_flow for e in edges]
    row.update({
        "nodes": len(nodes),
        "edges": len(edges),
        "exits": sum(1 for n in nodes if n.type == "exit"),
        "total_edge_length_m": float(sum(e.distance for e in edges)),
        "min_max_flow": float(min(flows)) if flows else 0.0,
        "mean_max_flow": float(sum(flows) / len(flows)) if flows else 0.0,
        "hazards": len(hazards),
        "max_severity": float(max((h["severity"] for h in hazards), default=0)),
        "max_spread_rate": float(max((h["spread_rate"] for h in hazards), default=0)),
        "fire_or_smoke": float(any(h["type"] in ("fire", "smoke") for h in hazards)),
    })
    for mobility in MOBILITIES:
        row[f"speed_{mobility}"] = float(values[f"speed_{mobility}_m_per_s"])
    for name in ALGORITHMS:
        row[f"algorithm_{name}"] = float(algorithm == name)

    # Route lengths at the start (hazards already present at time 0).
    hazard = hazard_context(
        nodes, edges, _ns(hazards), 0.0,
        horizon_minutes=values["hazard_risk_horizon_minutes"],
        risk_cost_metres=values["hazard_risk_cost_metres"],
        smoke_blocking_severity=values["smoke_blocking_severity"],
    )
    groups: dict[tuple, int] = {}
    for agent in agents:
        key = (agent["node_id"], agent["mobility"])
        groups[key] = groups.get(key, 0) + 1
    lengths, without = [], 0
    for (node_id, mobility), count in groups.items():
        try:
            route = nearest_safe_exit(nodes, edges, node_id, mobility=mobility,
                                      algorithm=algorithm, hazard=hazard)
            lengths += [route.distance_metres] * count
        except (NoRouteError, InvalidRouteRequest):
            without += count
    row["mean_route_m"] = float(sum(lengths) / len(lengths)) if lengths else 0.0
    row["max_route_m"] = float(max(lengths)) if lengths else 0.0
    row["people_without_route"] = float(without)
    return row


def _vector(row: dict[str, float]) -> list[float]:
    return [float(row[name]) for name in FEATURES]


# --- AI 1: predictor -----------------------------------------------------------------------

def train_predictor(rows: list[dict[str, float]], targets: list[float]) -> tuple[RandomForestRegressor, dict]:
    X = np.array([_vector(r) for r in rows], dtype=float)
    y = np.array(targets, dtype=float)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=RANDOM_STATE,
    )
    model = RandomForestRegressor(n_estimators=200, random_state=RANDOM_STATE, min_samples_leaf=2)
    model.fit(X_train, y_train)
    predicted = model.predict(X_test)
    baseline = np.full_like(y_test, y_train.mean())
    metrics = {
        "mae_s": round(float(mean_absolute_error(y_test, predicted)), 3),
        "r2": round(float(r2_score(y_test, predicted)), 4) if len(y_test) > 1 else None,
        "baseline_mae_s": round(float(mean_absolute_error(y_test, baseline)), 3),
        "training_runs": int(len(y_train)),
        "test_runs": int(len(y_test)),
        "features": list(FEATURES),
        "algorithm": "RandomForestRegressor(n_estimators=200, min_samples_leaf=2)",
    }
    return model, metrics


def model_path(model_dir: Path, organization_id: int, model_id: int) -> Path:
    return Path(model_dir) / f"org-{organization_id}" / f"{PREDICTOR_TYPE}-{model_id}.joblib"


def save_model(model, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, path)


def load_model(model_dir: Path, path_text: str):
    """Load a model file written by this server; refuse anything outside model_dir."""
    root = Path(model_dir).resolve()
    path = Path(path_text).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return joblib.load(path)


def predict(model, row: dict[str, float]) -> float:
    return float(model.predict(np.array([_vector(row)], dtype=float))[0])


# --- AI 5: alerts --------------------------------------------------------------------------

ALERT_FEATURES = ("evacuation_or_duration_s", "max_planned_queue_minutes", "blocked_nodes")


def alert_features(results: dict) -> dict[str, float]:
    summary = results.get("summary", {})
    time_s = summary.get("evacuation_time_s")
    if time_s is None:
        time_s = summary.get("simulated_seconds", 0.0)
    queues = [e.get("queue_minutes", 0.0) for e in results.get("static_analysis", {}).get("edges", [])]
    timeline = results.get("timeline") or [{}]
    return {
        "evacuation_or_duration_s": float(time_s or 0.0),
        "max_planned_queue_minutes": float(max(queues, default=0.0)),
        "blocked_nodes": float(len(timeline[-1].get("blocked_nodes", []))),
    }


LABELS = {
    "evacuation_or_duration_s": ("evacuation time", "s"),
    "max_planned_queue_minutes": ("highest corridor queue", "min"),
    "blocked_nodes": ("blocked nodes", ""),
}


def _describe(name: str, value: float) -> str:
    label, unit = LABELS[name]
    number = f"{value:.0f}" if name != "max_planned_queue_minutes" else f"{value:.1f}"
    return f"{label} {number}{(' ' + unit) if unit else ''}"


def anomalies(run_rows: list[tuple[int, dict[str, float]]]) -> list[dict]:
    """IsolationForest over runs; returns [{run_id, reason, score}] for unusual runs."""
    X = np.array([[row[f] for f in ALERT_FEATURES] for _, row in run_rows], dtype=float)
    forest = IsolationForest(n_estimators=200, random_state=RANDOM_STATE, contamination="auto")
    labels = forest.fit_predict(X)
    scores = forest.score_samples(X)
    q1, median, q3 = np.percentile(X, [25, 50, 75], axis=0)
    spread = q3 - q1
    found = []
    for index, (run_id, row) in enumerate(run_rows):
        if labels[index] != -1:
            continue
        unusual = []
        for j, name in enumerate(ALERT_FEATURES):
            value = X[index, j]
            if value > q3[j] + 1.5 * spread[j] or value < q1[j] - 1.5 * spread[j]:
                unusual.append(f"{_describe(name, value)} (typical {_describe(name, median[j])})")
        reason = ("Unusual run: " + "; ".join(unusual)) if unusual else (
            "Unusual combination of " + ", ".join(_describe(n, X[index, j]) for j, n in enumerate(ALERT_FEATURES)))
        found.append({"run_id": run_id, "reason": reason, "score": round(float(scores[index]), 4)})
    found.sort(key=lambda item: item["score"])
    return found


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
