"""The full DEMO hospital (scripts/seed_full_demo.py), loaded into health11_test
inside the test's transaction (rolled back afterwards, nothing kept)."""

import importlib.util
import sys
from pathlib import Path

import pytest
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, Patient, Staff
from fastapi.testclient import TestClient
from sqlalchemy import func, select

API = "/api/v1"
PASSWORD = "Demo-Password-2026!"
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _module():
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("seed_full_demo", SCRIPTS / "seed_full_demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


demo = _module()


@pytest.fixture
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


def login(client, slug, email):
    response = client.post(f"{API}/auth/login", json={"organization_slug": slug, "email": email,
                                                     "password": PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_the_full_demo_is_complete_labelled_and_feeds_the_ai(client, db_session):
    summary = demo.load_full_demo(client, PASSWORD)
    slug = summary["organization"]["slug"]
    org_id = summary["organization"]["id"]
    admin = login(client, slug, "city.admin@example.com")

    # Three accounts, one per role.
    users = client.get(f"{API}/users", headers=admin, params={"limit": 50}).json()["items"]
    assert sorted(u["role"] for u in users) == ["Administrator", "Emergency Commander", "Staff User"]

    # The hospital has a map position, three floors joined by stairs and the evacuation lift.
    hospital = client.get(f"{API}/hospitals/{summary['hospital_id']}", headers=admin).json()
    assert (hospital["latitude"], hospital["longitude"]) == demo.POSITION
    floors = client.get(f"{API}/floors", headers=admin, params={"limit": 50}).json()["items"]
    assert sorted(f["floor_number"] for f in floors) == [0, 1, 2]
    nodes = client.get(f"{API}/nodes", headers=admin, params={"limit": 200}).json()["items"]
    lifts = [n for n in nodes if n["type"] == "lift"]
    assert len(lifts) == 3 and all(n["is_evacuation_lift"] for n in lifts)
    assert {n["type"] for n in nodes} >= {"ward", "icu", "room", "corridor", "stair", "ramp", "lift", "exit", "assembly"}

    # Synthetic people, every mobility type, all placed.
    patients = db_session.scalars(select(Patient).where(Patient.organization_id == org_id)).all()
    staff = db_session.scalars(select(Staff).where(Staff.organization_id == org_id)).all()
    assert len(patients) == 40 and len(staff) == 15
    assert all(p.is_synthetic and p.node_id and p.patient_code.startswith("DEMO-") for p in patients)
    assert all(s.is_synthetic and s.node_id and "Synthetic" in s.full_name for s in staff)
    assert {p.mobility.value for p in patients} == {"ambulatory", "wheelchair", "stretcher", "ventilator"}

    # 15 scenarios x 4 methods = 60 real runs; the drill gets everyone out.
    assert len(summary["scenario_ids"]) == 15 and summary["runs"] == 60
    runs = client.get(f"{API}/simulation_runs", headers=admin, params={"limit": 100}).json()
    assert runs["total"] == 60
    drill = summary["scenario_ids"][4]
    drill_run = next(r for r in runs["items"] if r["scenario_id"] == drill)
    detail = client.get(f"{API}/simulation_runs/{drill_run['id']}", headers=admin).json()
    assert detail["status"] == "completed" and detail["summary"]["all_evacuated"] is True

    # Enough runs: the predictor gives a number with its accuracy, alerts work.
    predicted = client.post(f"{API}/predict", headers=admin, json={
        "scenario_id": summary["scenario_ids"][0], "building_id": summary["building_id"]})
    assert predicted.status_code == 200, predicted.text
    assert predicted.json()["predicted_time_s"] is not None and predicted.json()["mae"] is not None
    alerts = client.get(f"{API}/alerts", headers=admin).json()
    assert not alerts.get("message")

    # The same seed gives the same people: a second build of the list matches.
    import random
    again, _ = demo.build_people(random.Random(demo.SEED))
    assert [p["mobility"] for p in again] == [p.mobility.value for p in sorted(patients, key=lambda p: p.patient_code)]

    assert db_session.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.organization_id == org_id, AuditLog.action == "simulation.created")) == 60


def test_a_stretcher_on_floor_2_uses_the_evacuation_lift_in_a_fire(client):
    summary = demo.load_full_demo(client, PASSWORD, run_simulations=False)
    admin = login(client, summary["organization"]["slug"], "city.admin@example.com")
    ward_2a = summary["node_ids"]["Ward 2A"]
    floor_2 = client.get(f"{API}/nodes/{ward_2a}", headers=admin).json()["floor_id"]
    fire_floor_1 = summary["scenario_ids"][1]
    route = client.post(f"{API}/floors/{floor_2}/route", headers=admin, json={
        "start": "Ward 2A", "mobility": "stretcher", "algorithm": "dijkstra", "scenario_id": fire_floor_1})
    assert route.status_code == 200, route.text
    names = route.json()["node_names"]
    assert "Lift E 2" in names and not any(n.startswith("Stair") for n in names)
    assert names[-1] in {"Main Entrance Exit", "East Exit"}


def test_the_staff_account_is_read_only(client):
    summary = demo.load_full_demo(client, PASSWORD, run_simulations=False)
    staff = login(client, summary["organization"]["slug"], "city.staff@example.com")
    assert client.get(f"{API}/patients", headers=staff).status_code == 200
    assert client.post(f"{API}/scenarios", headers=staff, json={"name": "x", "hazards": []}).status_code == 403
