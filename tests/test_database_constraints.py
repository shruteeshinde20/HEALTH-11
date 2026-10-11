from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import DataError, IntegrityError

from app.models import (
    AuditLog,
    Building,
    Edge,
    EvacuationPlan,
    Floor,
    Hazard,
    HazardType,
    Hospital,
    MLModel,
    Node,
    NodeType,
    Organization,
    Parameter,
    Patient,
    PatientMobility,
    Scenario,
    SimulationRun,
    Staff,
    User,
    UserRole,
)


def make_graph(db):
    org = Organization(
        name="Test Hospital Group",
        slug="test-hospital-group",
    )
    db.add(org)
    db.flush()

    user = User(
        organization_id=org.id,
        email="admin@example.test",
        password_hash="test-hash-not-a-real-secret",
        full_name="Test Admin",
        role=UserRole.ADMINISTRATOR,
    )
    hospital = Hospital(
        organization_id=org.id,
        name="Test Hospital",
        address="Test address",
        timezone="Asia/Kolkata",
    )
    db.add_all([user, hospital])
    db.flush()

    building = Building(
        organization_id=org.id,
        hospital_id=hospital.id,
        name="Main Building",
    )
    db.add(building)
    db.flush()

    floor = Floor(
        organization_id=org.id,
        building_id=building.id,
        floor_number=1,
        name="Ground Floor",
    )
    db.add(floor)
    db.flush()

    node_a = Node(
        organization_id=org.id,
        floor_id=floor.id,
        name="Room A",
        type=NodeType.ROOM,
        x=0,
        y=0,
        capacity=10,
    )
    node_b = Node(
        organization_id=org.id,
        floor_id=floor.id,
        name="Exit A",
        type=NodeType.EXIT,
        x=10,
        y=0,
        capacity=50,
    )
    db.add_all([node_a, node_b])
    db.flush()

    return org, user, hospital, building, floor, node_a, node_b


def test_every_model_accepts_valid_insert_and_read(db_session):
    org, user, hospital, building, floor, node_a, node_b = make_graph(
        db_session
    )

    edge = Edge(
        organization_id=org.id,
        from_node_id=node_a.id,
        to_node_id=node_b.id,
        distance=10.0,
        width=2.0,
        max_flow=5,
    )
    patient = Patient(
        organization_id=org.id,
        patient_code="PAT-001",
        mobility=PatientMobility.AMBULATORY,
        criticality=3,
        node_id=node_a.id,
    )
    staff = Staff(
        organization_id=org.id,
        staff_code="STF-001",
        full_name="Test Nurse",
        role="nurse",
        node_id=node_a.id,
    )
    hazard = Hazard(
        organization_id=org.id,
        name="Test Fire",
        type=HazardType.FIRE,
        origin_node_id=node_a.id,
        spread_rate=0.5,
        severity=2,
    )
    scenario = Scenario(
        organization_id=org.id,
        name="Fire Drill",
        description="Test scenario",
        created_by_user_id=user.id,
    )
    parameter = Parameter(
        organization_id=org.id,
        name="walking_speed",
        value="1.2",
        unit="m/s",
        source="test",
    )

    db_session.add_all(
        [edge, patient, staff, hazard, scenario, parameter]
    )
    db_session.flush()

    simulation = SimulationRun(
        organization_id=org.id,
        scenario_id=scenario.id,
        algorithm="dijkstra",
        params={"test": True},
        results={"routes": 1},
        status="completed",
    )
    plan = EvacuationPlan(
        organization_id=org.id,
        scenario_id=scenario.id,
        name="Primary Plan",
        routes={"route": [node_a.id, node_b.id]},
        status="draft",
    )
    audit = AuditLog(
        organization_id=org.id,
        actor_user_id=user.id,
        action="create",
        entity_type="scenario",
        entity_id=scenario.id,
        details={"test": True},
        ip_address="127.0.0.1",
    )
    ml_model = MLModel(
        organization_id=org.id,
        model_type="risk_classifier",
        metrics={"accuracy": 0.9},
        trained_at=datetime.now(timezone.utc),
        file_path="models/test-model.bin",
    )

    db_session.add_all([simulation, plan, audit, ml_model])
    db_session.flush()

    # Verify the exact records inserted, not just any record of each model.
    expected_rows = [
        org,
        user,
        hospital,
        building,
        floor,
        node_a,
        node_b,
        edge,
        patient,
        staff,
        hazard,
        scenario,
        simulation,
        plan,
        parameter,
        audit,
        ml_model,
    ]

    for row in expected_rows:
        assert db_session.get(type(row), row.id) is not None, (
            f"{type(row).__name__} with id={row.id} was not found"
        )


def test_foreign_keys_reject_missing_parent(db_session):
    org, _, _, _, _, _, node_b = make_graph(db_session)

    invalid = Edge(
        organization_id=org.id,
        from_node_id=99999991,
        to_node_id=node_b.id,
        distance=1.0,
        width=1.0,
        max_flow=1,
    )
    db_session.add(invalid)

    with pytest.raises(IntegrityError):
        db_session.flush()

    db_session.rollback()


@pytest.mark.parametrize(
    "values",
    [
        {"distance": -0.01, "width": 1.0, "max_flow": 1},
        {"distance": 1.0, "width": 0.0, "max_flow": 1},
        {"distance": 1.0, "width": 1.0, "max_flow": 0},
    ],
)
def test_edge_check_constraints_reject_invalid_values(db_session, values):
    org, _, _, _, _, node_a, node_b = make_graph(db_session)

    db_session.add(
        Edge(
            organization_id=org.id,
            from_node_id=node_a.id,
            to_node_id=node_b.id,
            **values,
        )
    )

    with pytest.raises(IntegrityError):
        db_session.flush()

    db_session.rollback()


def test_invalid_node_enum_is_rejected(db_session):
    org, _, _, _, floor, _, _ = make_graph(db_session)

    with pytest.raises((IntegrityError, DataError)):
        db_session.execute(
            text(
                """
                INSERT INTO nodes
                    (organization_id, floor_id, name, type, x, y,
                     capacity, is_blocked)
                VALUES
                    (:org, :floor, 'Bad type', 'unknown_node_type',
                     0, 0, 0, false)
                """
            ),
            {"org": org.id, "floor": floor.id},
        )
        db_session.flush()

    db_session.rollback()


def test_invalid_user_role_is_rejected(db_session):
    org, _, _, _, _, _, _ = make_graph(db_session)

    with pytest.raises((IntegrityError, DataError)):
        db_session.execute(
            text(
                """
                INSERT INTO users
                    (organization_id, email, password_hash, full_name,
                     role, is_active)
                VALUES
                    (:org, 'bad-role@example.test', 'hash',
                     'Bad Role', 'unknown_role', true)
                """
            ),
            {"org": org.id},
        )
        db_session.flush()

    db_session.rollback()


def test_unique_constraints_reject_duplicate_hospital_name_per_org(
    db_session,
):
    org, _, _, _, _, _, _ = make_graph(db_session)

    db_session.add(
        Hospital(organization_id=org.id, name="Unique Test")
    )
    db_session.flush()

    db_session.add(
        Hospital(organization_id=org.id, name="Unique Test")
    )

    with pytest.raises(IntegrityError):
        db_session.flush()

    db_session.rollback()


def test_every_hospital_data_table_requires_organization_id(engine):
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    expected = {
        "users",
        "hospitals",
        "buildings",
        "floors",
        "nodes",
        "edges",
        "patients",
        "staff",
        "hazards",
        "scenarios",
        "simulation_runs",
        "evacuation_plans",
        "parameters",
        "audit_log",
        "ml_models",
    }

    assert expected <= tables

    for table in sorted(expected):
        columns = {
            column["name"]: column
            for column in inspector.get_columns(table)
        }

        assert "organization_id" in columns, (
            f"{table} has no organization_id column"
        )
        assert columns["organization_id"]["nullable"] is False, (
            f"{table}.organization_id must be NOT NULL"
        )


def test_deleted_at_can_be_persisted_without_removing_row(db_session):
    org, _, _, _, _, _, _ = make_graph(db_session)

    parameter = Parameter(
        organization_id=org.id,
        name="soft-delete-test",
        value="1",
        source="test",
    )
    db_session.add(parameter)
    db_session.flush()

    row_id = parameter.id
    parameter.deleted_at = datetime.now(timezone.utc)
    db_session.flush()
    db_session.expire(parameter)

    stored = db_session.get(Parameter, row_id)

    assert stored is not None
    assert stored.deleted_at is not None