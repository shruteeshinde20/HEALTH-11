"""Phase 6: AI features 1 (time predictor), 2 (priority scoring) and
5 (anomaly alerts), with honesty rules: no number without enough data,
real held-out accuracy, full score breakdowns."""

import random
from pathlib import Path
from types import SimpleNamespace as N

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import _password_hash
from app.config import get_settings
from app.db_session import get_db
from app.main import app
from app.models import MLModel, SimulationRun, User, UserRole
from app.services import ml, priority

API = "/api/v1"
PASSWORD = "StrongPassword!234"
PRIORITY_DEFAULTS = {
    "priority_weight_mobility": 0.4, "priority_weight_criticality": 0.3,
    "priority_weight_hazard": 0.3, "priority_mobility_ambulatory": 0.0,
    "priority_mobility_wheelchair": 0.5, "priority_mobility_stretcher": 0.8,
    "priority_mobility_ventilator": 1.0, "priority_hazard_distance_m": 50.0,
}


# --- AI 2: priority scoring (unit) ----------------------------------------------------------

def line_building():
    nodes = [N(id=i, name=f"N{i}") for i in range(1, 5)]
    edges = [N(from_node_id=1, to_node_id=2, distance=25), N(from_node_id=2, to_node_id=3, distance=25),
             N(from_node_id=3, to_node_id=4, distance=25)]
    return nodes, edges


def patient(pid, mobility, criticality, node_id):
    return N(id=pid, patient_code=f"P{pid}", mobility=mobility, criticality=criticality,
             node_id=node_id, is_synthetic=True)


def test_priority_formula_and_breakdown():
    nodes, edges = line_building()
    fire = [N(origin_node_id=1, is_active=True)]
    rows = priority.score_patients(
        [patient(1, "ambulatory", 1, 4), patient(2, "wheelchair", 3, 2), patient(3, "ventilator", 5, 1)],
        nodes, edges, fire, PRIORITY_DEFAULTS, has_scenario=True)
    assert [(r["patient_id"], r["score"], r["rank"]) for r in rows] == [(3, 100.0, 1), (2, 50.0, 2), (1, 0.0, 3)]
    middle = rows[1]["breakdown"]
    assert middle["mobility"] == {"value": "wheelchair", "factor": 0.5, "weight": 0.4, "points": 20.0}
    assert middle["criticality"]["factor"] == 0.5 and middle["criticality"]["points"] == 15.0
    assert middle["hazard"]["distance_m"] == 25 and middle["hazard"]["factor"] == 0.5
    assert middle["hazard"]["explanation"] == "25 m from the nearest hazard origin"
    assert sum(p["points"] for p in middle.values()) == pytest.approx(rows[1]["score"])


def test_priority_without_scenario_ignores_hazard():
    nodes, edges = line_building()
    rows = priority.score_patients([patient(1, "stretcher", 5, 1)], nodes, edges, [],
                                   PRIORITY_DEFAULTS, has_scenario=False)
    assert rows[0]["breakdown"]["hazard"] == {"distance_m": None, "factor": 0.0,
                                               "explanation": "no scenario selected",
                                               "weight": 0.3, "points": 0.0}
    assert rows[0]["score"] == pytest.approx(100 * (0.4 * 0.8 + 0.3 * 1.0))


def test_priority_score_is_normalised_by_the_weights():
    nodes, edges = line_building()
    weights = {**PRIORITY_DEFAULTS, "priority_weight_mobility": 1.0,
               "priority_weight_criticality": 1.0, "priority_weight_hazard": 1.0}
    rows = priority.score_patients([patient(1, "ventilator", 5, 1), patient(2, "wheelchair", 3, 2)],
                                   nodes, edges, [N(origin_node_id=1, is_active=True)], weights,
                                   has_scenario=True)
    assert [r["score"] for r in rows] == [100.0, 50.0]


def test_priority_ties_break_on_criticality_then_id():
    nodes, edges = line_building()
    rows = priority.score_patients(
        [patient(5, "ambulatory", 1, 4), patient(2, "ambulatory", 1, 4)],
        nodes, edges, [], {**PRIORITY_DEFAULTS, "priority_weight_criticality": 0.0},
        has_scenario=False)
    assert [r["patient_id"] for r in rows] == [2, 5]


# --- AI 1 / 5 helpers (unit) -----------------------------------------------------------------

def test_model_files_are_only_loaded_from_the_model_folder(tmp_path):
    inside = tmp_path / "models" / "org-1" / "m.joblib"
    ml.save_model({"ok": True}, inside)
    assert ml.load_model(tmp_path / "models", str(inside)) == {"ok": True}
    outside = tmp_path / "elsewhere.joblib"
    ml.save_model({"evil": True}, outside)
    assert ml.load_model(tmp_path / "models", str(outside)) is None
    assert ml.load_model(tmp_path / "models", str(tmp_path / "models" / ".." / "elsewhere.joblib")) is None


def test_predictor_does_not_look_accurate_on_pure_noise():
    rng = random.Random(5)
    rows = [{name: rng.uniform(0, 100) for name in ml.FEATURES} for _ in range(80)]
    targets = [rng.uniform(100, 300) for _ in range(80)]
    _, metrics = ml.train_predictor(rows, targets)
    assert (metrics["training_runs"], metrics["test_runs"]) == (60, 20)
    # Accuracy is measured on held-out runs, so noise cannot look predictable.
    assert metrics["mae_s"] > 0.8 * metrics["baseline_mae_s"]
    assert metrics["r2"] < 0.2


def test_anomaly_detection_flags_the_odd_run_and_explains_why():
    rng = random.Random(7)
    rows = [(i, {"evacuation_or_duration_s": 120 + rng.uniform(-10, 10),
                 "max_planned_queue_minutes": 1 + rng.uniform(-0.2, 0.2),
                 "blocked_nodes": float(rng.choice([1, 1, 2]))}) for i in range(1, 60)]
    rows.append((99, {"evacuation_or_duration_s": 900.0, "max_planned_queue_minutes": 1.0,
                      "blocked_nodes": 1.0}))
    found = ml.anomalies(rows)
    assert found[0]["run_id"] == 99
    assert "evacuation time 900 s" in found[0]["reason"] and "typical" in found[0]["reason"]


# --- API -------------------------------------------------------------------------------------

@pytest.fixture
def client(db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "model_dir", tmp_path / "models")

    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


SPEC_NODES = [("ICU", "icu"), ("WardA", "ward"), ("C1", "corridor"), ("C2", "corridor"),
              ("S1", "stair"), ("S2", "stair"), ("R1", "ramp"), ("R2", "ramp"),
              ("E1", "exit"), ("E2", "exit")]
SPEC_EDGES = [("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18),
              ("R1", "E1", 15), ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12),
              ("C2", "S2", 10), ("S2", "E2", 25), ("C2", "R2", 16), ("R2", "E2", 20)]


class Site:
    def __init__(self, client, db_session, name):
        self.client, self.db = client, db_session
        body = client.post(f"{API}/auth/register-organization", json={
            "organization_name": name, "full_name": "Admin",
            "email": "admin@example.com", "password": PASSWORD}).json()
        self.org_id, self.slug = body["organization"]["id"], body["organization"]["slug"]
        self.headers = {"Authorization": f"Bearer {body['access_token']}"}
        hospital = self.post("/hospitals", {"name": "Hospital", "timezone": "UTC"})
        self.building = self.post("/buildings", {"hospital_id": hospital["id"], "name": "Main"})["id"]
        floor = self.post("/floors", {"building_id": self.building, "floor_number": 0, "name": "G"})["id"]
        self.ids = {n: self.post("/nodes", {"floor_id": floor, "name": n, "type": k})["id"]
                    for n, k in SPEC_NODES}
        for a, b, metres in SPEC_EDGES:
            self.post("/edges", {"from_node_id": self.ids[a], "to_node_id": self.ids[b],
                                 "distance": metres, "width": 2, "max_flow": 30})
        self.staff = 0

    def post(self, path, payload, expect=201):
        response = self.client.post(f"{API}{path}", headers=self.headers, json=payload)
        assert response.status_code == expect, response.text
        return response.json()

    def add_staff(self, node, count):
        for _ in range(count):
            self.staff += 1
            self.post("/staff", {"staff_code": f"S{self.staff}", "full_name": f"N{self.staff}",
                                 "role": "nurse", "node_id": self.ids[node]})

    def set_parameter(self, name, value):
        listed = self.client.get(f"{API}/parameters", headers=self.headers, params={"q": name}).json()
        match = [p for p in listed["items"] if p["name"] == name]
        if match:
            self.client.patch(f"{API}/parameters/{match[0]['id']}", headers=self.headers,
                              json={"value": str(value)})
        else:
            self.post("/parameters", {"name": name, "value": str(value), "source": "test"})


def build_history(site, runs=40, seed=3):
    """Real simulation runs with varied people, places and speeds."""
    rng = random.Random(seed)
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    for i in range(runs):
        site.add_staff(rng.choice(["ICU", "WardA", "C1", "C2"]), rng.randint(1, 4))
        site.set_parameter("speed_ambulatory_m_per_s", round(rng.uniform(0.6, 1.8), 2))
        site.post("/simulate", {"scenario_id": scenario, "building_id": site.building,
                                "algorithm": rng.choice(["dijkstra", "astar", "bfs"])})
    return scenario


def test_predict_without_enough_runs_gives_no_number(client, db_session):
    site = Site(client, db_session, "Predict Empty")
    site.add_staff("WardA", 2)
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    body = client.post(f"{API}/predict", headers=site.headers,
                       json={"scenario_id": scenario, "building_id": site.building}).json()
    assert body["predicted_time_s"] is None and body["mae"] is None and body["r2"] is None
    assert body["note"].startswith("Not enough data: 0 complete simulation runs; at least 30")
    assert "not a measurement of real evacuations" in body["method"]


def test_predict_needs_the_minimum_number_of_complete_runs(client, db_session):
    site = Site(client, db_session, "Predict Few")
    scenario = build_history(site, runs=12)
    body = client.post(f"{API}/predict", headers=site.headers,
                       json={"scenario_id": scenario, "building_id": site.building}).json()
    assert body["predicted_time_s"] is None
    assert body["note"].startswith("Not enough data: 12 complete simulation runs; at least 30")
    site.post("/parameters", {"name": "predictor_min_runs", "value": "10", "source": "test"})
    trained = client.post(f"{API}/predict", headers=site.headers,
                          json={"scenario_id": scenario, "building_id": site.building}).json()
    assert trained["predicted_time_s"] is not None


def test_predict_trains_reports_real_accuracy_and_reuses_the_model(client, db_session, tmp_path):
    site = Site(client, db_session, "Predict Org")
    scenario = build_history(site)
    # One incomplete run (someone left behind) must not be used for training.
    site.add_staff("R1", 1)
    cut_off = site.post("/scenarios", {"name": "Cut off", "hazards": [
        {"name": "F1", "type": "fire", "origin_node_id": site.ids["C1"]},
        {"name": "F2", "type": "fire", "origin_node_id": site.ids["C2"]}]})["id"]
    incomplete = site.post("/simulate", {"scenario_id": cut_off})["run_id"]
    summary = client.get(f"{API}/simulation_runs/{incomplete}", headers=site.headers).json()["summary"]
    assert summary["evacuated"] >= 1 and summary["all_evacuated"] is False
    body = client.post(f"{API}/predict", headers=site.headers,
                       json={"scenario_id": scenario, "building_id": site.building}).json()
    assert body["predicted_time_s"] is not None and body["predicted_time_s"] > 0
    about = body["about"]
    assert about["training_runs"] + about["test_runs"] == 40 and about["test_runs"] == 10
    assert body["mae"] < about["baseline_mae_s"]  # better than guessing the average
    assert "held out" in body["note"]
    record = db_session.get(MLModel, about["model_id"])
    assert record.organization_id == site.org_id and record.model_type == ml.PREDICTOR_TYPE
    assert Path(record.file_path).is_file() and (tmp_path / "models") in Path(record.file_path).parents

    again = client.post(f"{API}/predict", headers=site.headers,
                        json={"scenario_id": scenario, "building_id": site.building}).json()
    assert again["about"]["model_id"] == about["model_id"]
    assert again["predicted_time_s"] == body["predicted_time_s"]

    site.post("/simulate", {"scenario_id": scenario, "building_id": site.building})
    retrained = client.post(f"{API}/predict", headers=site.headers,
                            json={"scenario_id": scenario, "building_id": site.building}).json()
    assert retrained["about"]["model_id"] != about["model_id"]
    assert retrained["about"]["training_runs"] + retrained["about"]["test_runs"] == 41


def test_predict_refuses_when_people_have_no_safe_route(client, db_session):
    site = Site(client, db_session, "Predict Blocked")
    site.add_staff("WardA", 2)
    scenario = site.post("/scenarios", {"name": "Cut off", "hazards": [
        {"name": "F1", "type": "fire", "origin_node_id": site.ids["C1"]},
        {"name": "F2", "type": "fire", "origin_node_id": site.ids["C2"]}]})["id"]
    body = client.post(f"{API}/predict", headers=site.headers, json={"scenario_id": scenario}).json()
    assert body["predicted_time_s"] is None
    assert body["note"].startswith("2 people have no safe route")


def test_predict_roles_and_isolation(client, db_session):
    site = Site(client, db_session, "Predict Roles")
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    db_session.add(User(organization_id=site.org_id, email="staff@example.com",
                        password_hash=_password_hash(PASSWORD), full_name="Staff",
                        role=UserRole.STAFF_USER, is_active=True))
    db_session.flush()
    token = client.post(f"{API}/auth/login", json={"organization_slug": site.slug,
                                                  "email": "staff@example.com",
                                                  "password": PASSWORD}).json()["access_token"]
    staff = {"Authorization": f"Bearer {token}"}
    assert client.post(f"{API}/predict", headers=staff, json={"scenario_id": scenario}).status_code == 403
    assert client.get(f"{API}/alerts", headers=staff).status_code == 200
    assert client.get(f"{API}/patient_priority", headers=staff).status_code == 200

    other = Site(client, db_session, "Predict Other")
    assert client.post(f"{API}/predict", headers=other.headers,
                       json={"scenario_id": scenario}).status_code == 422


def _fake_run(org_id, scenario_id, seconds, queue=1.0, blocked=1, left=0, bottleneck=False):
    return SimulationRun(
        organization_id=org_id, scenario_id=scenario_id, algorithm="astar", status="completed",
        params={"snapshot": {"building_id": None}},
        results={
            "summary": {"evacuation_time_s": seconds, "simulated_seconds": seconds,
                        "total": 10, "needs_assistance": left, "reached_by_hazard": 0,
                        "all_evacuated": left == 0},
            "static_analysis": {"edges": [{"queue_minutes": queue}]},
            "timeline": [{"blocked_nodes": list(range(blocked))}],
            "bottlenecks": [{"label": "C1 – S1", "reasons": ["long queue in simulation"]}]
            if bottleneck else [],
        },
    )


def test_alerts_need_fifty_runs_but_still_report_safety_and_bottlenecks(client, db_session):
    site = Site(client, db_session, "Alerts Few")
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    db_session.add_all([_fake_run(site.org_id, scenario, 100),
                        _fake_run(site.org_id, scenario, 300, left=2, bottleneck=True)])
    db_session.flush()
    body = client.get(f"{API}/alerts", headers=site.headers).json()
    assert body["message"] == ("More data needed: unusual-run detection needs at least 50 "
                               "simulation runs; there are 2.")
    kinds = sorted(a["kind"] for a in body["alerts"])
    assert kinds == ["bottleneck", "safety"]
    assert all({"run_id", "reason"} <= set(a) for a in body["alerts"])


def test_alerts_flag_unusual_runs_and_stay_inside_the_organization(client, db_session):
    site = Site(client, db_session, "Alerts Many")
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    rng = random.Random(11)
    db_session.add_all([_fake_run(site.org_id, scenario, 120 + rng.uniform(-8, 8),
                                  queue=1 + rng.uniform(-0.1, 0.1)) for _ in range(55)])
    odd = _fake_run(site.org_id, scenario, 1500, queue=9.0, blocked=6)
    db_session.add(odd)
    db_session.flush()
    body = client.get(f"{API}/alerts", headers=site.headers).json()
    assert body["message"] is None and body["runs_considered"] == 56
    anomalies = [a for a in body["alerts"] if a["kind"] == "anomaly"]
    assert anomalies[0]["run_id"] == odd.id
    assert "evacuation time 1500 s" in anomalies[0]["reason"]

    other = Site(client, db_session, "Alerts Other")
    theirs = client.get(f"{API}/alerts", headers=other.headers).json()
    assert theirs["alerts"] == [] and theirs["runs_considered"] == 0


def test_patient_priority_api(client, db_session):
    site = Site(client, db_session, "Priority Org")
    scenario = site.post("/scenarios", {"name": "Fire C1", "hazards": [
        {"name": "Fire", "type": "fire", "origin_node_id": site.ids["C1"]}]})["id"]
    for code, mobility, criticality, node in (("A", "ambulatory", 1, "E2"),
                                              ("B", "ventilator", 5, "ICU"),
                                              ("C", "wheelchair", 3, "WardA")):
        site.post("/patients", {"patient_code": code, "mobility": mobility,
                                "criticality": criticality, "node_id": site.ids[node]})
    body = client.get(f"{API}/patient_priority", headers=site.headers,
                      params={"scenario_id": scenario}).json()
    assert [p["patient_code"] for p in body["items"]] == ["B", "C", "A"]
    assert body["total"] == 3 and body["building_id"] == site.building
    icu = body["items"][0]["breakdown"]["hazard"]
    assert icu["distance_m"] == 10 and icu["factor"] == pytest.approx(0.8)
    assert all(p["source"] == "default (assumed, to be validated)" for p in body["parameters_used"])
    assert "not machine learning" in body["method"]

    page = client.get(f"{API}/patient_priority", headers=site.headers,
                      params={"scenario_id": scenario, "limit": 1, "offset": 1}).json()
    assert [p["patient_code"] for p in page["items"]] == ["C"] and page["total"] == 3

    for name in ("priority_weight_mobility", "priority_weight_criticality", "priority_weight_hazard"):
        site.post("/parameters", {"name": name, "value": "0", "source": "test"})
    assert client.get(f"{API}/patient_priority", headers=site.headers).status_code == 422

    other = Site(client, db_session, "Priority Other")
    assert client.get(f"{API}/patient_priority", headers=other.headers,
                      params={"scenario_id": scenario}).status_code == 422
    assert client.get(f"{API}/patient_priority", headers=other.headers).json()["items"] == []


def test_simulation_runs_store_predictor_features(client, db_session):
    site = Site(client, db_session, "Features Org")
    site.add_staff("WardA", 3)
    scenario = site.post("/scenarios", {"name": "Drill"})["id"]
    run_id = site.post("/simulate", {"scenario_id": scenario, "building_id": site.building,
                                     "algorithm": "dijkstra"})["run_id"]
    run = db_session.scalar(select(SimulationRun).where(SimulationRun.id == run_id))
    features = run.params["features"]
    assert set(features) == set(ml.FEATURES)
    assert features["people_total"] == 3 and features["people_ambulatory"] == 3
    assert features["algorithm_dijkstra"] == 1.0 and features["algorithm_astar"] == 0.0
    assert features["mean_route_m"] == pytest.approx(40)  # WardA -> C1 -> S1 -> E1
