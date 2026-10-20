"""Step 18: the DEMO seed (scripts/seed_demo.py).

load_demo() runs here against health11_test inside the test's transaction,
which is rolled back afterwards, so nothing is kept. The command-line part
refuses anything but ENVIRONMENT=development and the test databases.
"""

import importlib.util
import os
from pathlib import Path

import pytest
from app.db_session import get_db
from app.main import app
from app.models import AuditLog, Organization
from app.models.operations import Patient, Staff
from app.models.simulation import Parameter
from app.services.model_parameters import SPECS
from fastapi.testclient import TestClient
from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]

API = "/api/v1"
PASSWORD = "Demo-Password-2026!"


def _seed_module():
    spec = importlib.util.spec_from_file_location("seed_demo", PROJECT_ROOT / "scripts" / "seed_demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


seed = _seed_module()


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


@pytest.fixture
def demo(client):
    summary = seed.load_demo(client, PASSWORD)
    login = client.post(f"{API}/auth/login", json={
        "organization_slug": summary["organization"]["slug"],
        "email": seed.DEMO_ADMIN_EMAIL, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return summary, {"Authorization": f"Bearer {login.json()['access_token']}"}


def route(client, headers, floor_id, **payload):
    response = client.post(f"{API}/floors/{floor_id}/route", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    return body["node_names"], body["distance_metres"]


def test_demo_is_clearly_labelled_and_complete(demo, db_session):
    summary, _ = demo
    org = db_session.get(Organization, summary["organization"]["id"])
    assert org.name.startswith("DEMO") and "made-up" in org.name
    assert summary["nodes"] == 10 and summary["edges"] == 12

    patients = db_session.scalars(select(Patient).where(Patient.organization_id == org.id)).all()
    staff = db_session.scalars(select(Staff).where(Staff.organization_id == org.id)).all()
    assert len(patients) == len(seed.PATIENTS) and len(staff) == len(seed.STAFF)
    assert all(p.is_synthetic and p.patient_code.startswith("DEMO-") and p.node_id for p in patients)
    assert all(s.is_synthetic and s.staff_code.startswith("DEMO-") and "Synthetic" in s.full_name
               for s in staff)
    assert {p.mobility.value for p in patients} == {"ambulatory", "wheelchair", "stretcher", "ventilator"}


def test_default_parameters_are_stored_with_an_honest_source(demo, db_session):
    summary, _ = demo
    rows = db_session.scalars(select(Parameter).where(
        Parameter.organization_id == summary["organization"]["id"])).all()
    assert {r.name for r in rows} == set(SPECS)
    for row in rows:
        assert row.source == "assumed, to be validated"
        assert float(row.value) == SPECS[row.name].default and row.unit == SPECS[row.name].unit


def test_it_went_through_the_api_and_the_audit_log(demo, db_session):
    summary, _ = demo
    actions = set(db_session.scalars(select(AuditLog.action).where(
        AuditLog.organization_id == summary["organization"]["id"])).all())
    assert {"organization.registered", "patient.created", "scenario.created"} <= actions


def test_the_demo_floor_gives_the_project_test_case_routes(client, demo):
    summary, headers = demo
    floor = summary["floor_id"]
    assert route(client, headers, floor, start="WardA", mobility="ambulatory", algorithm="dijkstra") == (
        ["WardA", "C1", "S1", "E1"], 40)
    assert route(client, headers, floor, start="ICU", mobility="stretcher", algorithm="dijkstra") == (
        ["ICU", "C1", "R1", "E1"], 43)

    fire = summary["scenario_ids"][1]
    for algorithm in ("dijkstra", "astar"):
        assert route(client, headers, floor, start="WardA", mobility="ambulatory",
                     algorithm=algorithm, scenario_id=fire) == (["WardA", "C2", "S2", "E2"], 47)
        assert route(client, headers, floor, start="ICU", mobility="stretcher",
                     algorithm=algorithm, scenario_id=fire) == (["ICU", "C2", "R2", "E2"], 50)


@pytest.mark.parametrize("which", [0, 1])
def test_both_demo_scenarios_simulate_and_everyone_gets_out(client, demo, which):
    summary, headers = demo
    response = client.post(f"{API}/simulate", headers=headers, json={
        "scenario_id": summary["scenario_ids"][which], "algorithm": "astar",
        "building_id": summary["building_id"]})
    assert response.status_code == 201, response.text
    run = client.get(f"{API}/simulation_runs/{response.json()['run_id']}", headers=headers).json()
    assert run["status"] == "completed"
    assert run["summary"]["total"] >= len(seed.PATIENTS)
    assert run["summary"]["all_evacuated"] is True


def test_the_floor_file_matches_the_project_test_case():
    lines = seed.floor_csv().strip().split("\r\n")
    edges = [line.split(",") for line in lines if line.startswith("edge,")]
    assert {(e[8], e[9], float(e[10])) for e in edges} == {
        ("ICU", "C1", 10), ("C1", "S1", 12), ("S1", "E1", 20), ("C1", "R1", 18), ("R1", "E1", 15),
        ("ICU", "C2", 14), ("C1", "WardA", 8), ("WardA", "C2", 12), ("C2", "S2", 10), ("S2", "E2", 25),
        ("C2", "R2", 16), ("R2", "E2", 20)}


def test_a_weak_password_is_refused_before_anything_happens(monkeypatch):
    monkeypatch.setenv("DEMO_ADMIN_PASSWORD", "short")
    with pytest.raises(seed.SeedError, match="at least 12 characters"):
        seed._password()


@pytest.mark.parametrize("environment", ["test", "production"])
def test_it_refuses_anything_but_development(monkeypatch, environment):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "environment", environment)
    with pytest.raises(seed.SeedError, match="development only"):
        seed.main()


def test_it_refuses_the_test_database(monkeypatch):
    # Pointed explicitly at health11_test (never at the development database),
    # the seed must say no before it changes anything.
    from app.config import get_settings

    test_url = os.environ["TEST_DATABASE_URL"]
    assert test_url.rstrip("/").endswith("/health11_test")
    monkeypatch.setattr(get_settings(), "environment", "development")
    monkeypatch.setattr(get_settings(), "database_url", test_url)
    monkeypatch.setenv("DEMO_ADMIN_PASSWORD", PASSWORD)
    with pytest.raises(seed.SeedError, match="health11_test"):
        seed.main()
