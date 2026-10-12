"""Database-level guarantees added in Phase 2 (migration 8c4e1b7a92d0).

These run against the real PostgreSQL schema, so they prove the database
itself enforces the rules even if application code had a bug.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    Building,
    Edge,
    Floor,
    Hazard,
    HazardType,
    Hospital,
    Node,
    NodeType,
    Organization,
    Patient,
    PatientMobility,
    Scenario,
    Staff,
)


def org(db, slug):
    item = Organization(name=slug, slug=slug)
    db.add(item)
    db.flush()
    return item.id


def floor_with_nodes(db, org_id, suffix=""):
    hospital = Hospital(organization_id=org_id, name=f"H{suffix}")
    db.add(hospital)
    db.flush()
    building = Building(organization_id=org_id, hospital_id=hospital.id, name="B")
    db.add(building)
    db.flush()
    floor = Floor(organization_id=org_id, building_id=building.id, floor_number=0, name="G")
    db.add(floor)
    db.flush()
    a = Node(organization_id=org_id, floor_id=floor.id, name="A", type=NodeType.CORRIDOR)
    b = Node(organization_id=org_id, floor_id=floor.id, name="B", type=NodeType.EXIT)
    db.add_all([a, b])
    db.flush()
    return hospital, building, floor, a, b


def expect_integrity_error(db, row):
    db.add(row)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


# --- #8 tenant isolation enforced by the database ------------------------------

@pytest.mark.parametrize("kind", ["building", "floor", "node", "edge", "patient", "staff"])
def test_database_rejects_cross_organization_references(db_session, kind):
    org_a = org(db_session, "tenant-a")
    org_b = org(db_session, "tenant-b")
    hospital, building, floor, a, b = floor_with_nodes(db_session, org_a)

    rows = {
        "building": Building(organization_id=org_b, hospital_id=hospital.id, name="X"),
        "floor": Floor(organization_id=org_b, building_id=building.id, floor_number=7, name="X"),
        "node": Node(organization_id=org_b, floor_id=floor.id, name="X", type=NodeType.ROOM),
        "edge": Edge(organization_id=org_b, from_node_id=a.id, to_node_id=b.id,
                     distance=1, width=1, max_flow=1),
        "patient": Patient(organization_id=org_b, patient_code="P", node_id=a.id,
                           mobility=PatientMobility.AMBULATORY),
        "staff": Staff(organization_id=org_b, staff_code="S", full_name="S", role="nurse",
                       node_id=a.id),
    }
    expect_integrity_error(db_session, rows[kind])


def test_hazard_must_use_scenario_and_node_of_same_organization(db_session):
    org_a = org(db_session, "hazard-a")
    org_b = org(db_session, "hazard-b")
    *_, node_a, _ = floor_with_nodes(db_session, org_a)
    scenario_b = Scenario(organization_id=org_b, name="Other org scenario")
    db_session.add(scenario_b)
    db_session.flush()

    expect_integrity_error(db_session, Hazard(
        organization_id=org_b, scenario_id=scenario_b.id, name="Fire",
        type=HazardType.FIRE, origin_node_id=node_a.id,
    ))


def test_hazard_requires_a_scenario(db_session):
    org_a = org(db_session, "hazard-c")
    *_, node_a, _ = floor_with_nodes(db_session, org_a)
    expect_integrity_error(db_session, Hazard(
        organization_id=org_a, name="Fire", type=HazardType.FIRE,
        origin_node_id=node_a.id,
    ))


# --- #10 undirected edges ----------------------------------------------------------

def test_reverse_duplicate_edge_is_rejected(db_session):
    org_a = org(db_session, "edges-a")
    *_, a, b = floor_with_nodes(db_session, org_a)
    db_session.add(Edge(organization_id=org_a, from_node_id=a.id, to_node_id=b.id,
                        distance=5, width=1, max_flow=1))
    db_session.flush()
    expect_integrity_error(db_session, Edge(
        organization_id=org_a, from_node_id=b.id, to_node_id=a.id,
        distance=500, width=1, max_flow=1,
    ))


def test_edge_cannot_connect_node_to_itself(db_session):
    org_a = org(db_session, "edges-b")
    *_, a, _ = floor_with_nodes(db_session, org_a)
    expect_integrity_error(db_session, Edge(
        organization_id=org_a, from_node_id=a.id, to_node_id=a.id,
        distance=1, width=1, max_flow=1,
    ))


def test_soft_deleted_edge_can_be_recreated(db_session):
    org_a = org(db_session, "edges-c")
    *_, a, b = floor_with_nodes(db_session, org_a)
    old = Edge(organization_id=org_a, from_node_id=a.id, to_node_id=b.id,
               distance=5, width=1, max_flow=1)
    db_session.add(old)
    db_session.flush()
    old.deleted_at = datetime.now(timezone.utc)
    db_session.flush()
    db_session.add(Edge(organization_id=org_a, from_node_id=b.id, to_node_id=a.id,
                        distance=6, width=1, max_flow=1))
    db_session.flush()  # must not raise


# --- #21 uniqueness ignores soft-deleted rows -----------------------------------

def test_soft_deleted_names_can_be_reused(db_session):
    org_a = org(db_session, "reuse-a")
    hospital, *_ = floor_with_nodes(db_session, org_a)
    hospital.deleted_at = datetime.now(timezone.utc)
    db_session.flush()
    db_session.add(Hospital(organization_id=org_a, name=hospital.name))
    db_session.flush()  # reuse after soft delete: must not raise

    # But two active hospitals with the same name are still rejected.
    expect_integrity_error(db_session, Hospital(organization_id=org_a, name=hospital.name))


def test_patient_code_unique_per_organization(db_session):
    org_a = org(db_session, "patients-a")
    org_b = org(db_session, "patients-b")
    db_session.add(Patient(organization_id=org_a, patient_code="P-1",
                           mobility=PatientMobility.STRETCHER))
    db_session.add(Patient(organization_id=org_b, patient_code="P-1",
                           mobility=PatientMobility.STRETCHER))
    db_session.flush()
    expect_integrity_error(db_session, Patient(
        organization_id=org_a, patient_code="P-1", mobility=PatientMobility.AMBULATORY,
    ))
