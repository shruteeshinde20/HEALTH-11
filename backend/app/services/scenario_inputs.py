"""Load a building's graph and a scenario's hazard state from the database.

Everything is filtered by organization and ignores soft-deleted rows.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.facility import Floor
from app.models.graph import Edge, Node
from app.models.operations import Hazard
from app.services.hazards import HazardContext, hazard_context
from app.services.model_parameters import ParameterValue, load_parameters

HAZARD_PARAMETERS = [
    "hazard_risk_horizon_minutes",
    "hazard_risk_cost_metres",
    "smoke_blocking_severity",
]


def building_nodes_and_edges(db: Session, building_id: int, organization_id: int):
    """All active nodes and edges of a building (every floor)."""
    floor_ids = select(Floor.id).where(
        Floor.organization_id == organization_id,
        Floor.building_id == building_id,
        Floor.deleted_at.is_(None),
    )
    nodes = list(db.scalars(
        select(Node).where(
            Node.organization_id == organization_id,
            Node.floor_id.in_(floor_ids),
            Node.deleted_at.is_(None),
        ).order_by(Node.id)
    ).all())
    node_ids = [node.id for node in nodes]
    edges = []
    if node_ids:
        edges = list(db.scalars(
            select(Edge).where(
                Edge.organization_id == organization_id,
                Edge.from_node_id.in_(node_ids),
                Edge.to_node_id.in_(node_ids),
                Edge.deleted_at.is_(None),
            ).order_by(Edge.id)
        ).all())
    return nodes, edges


def scenario_hazards(db: Session, scenario_id: int, organization_id: int) -> list[Hazard]:
    return list(db.scalars(
        select(Hazard).where(
            Hazard.organization_id == organization_id,
            Hazard.scenario_id == scenario_id,
            Hazard.deleted_at.is_(None),
        ).order_by(Hazard.id)
    ).all())


def scenario_hazard_context(
    db: Session,
    organization_id: int,
    scenario_id: int,
    nodes,
    edges,
    minutes_elapsed: float,
    extra_parameters: list[str] = (),
) -> tuple[HazardContext, dict[str, ParameterValue]]:
    params = load_parameters(db, organization_id, HAZARD_PARAMETERS + list(extra_parameters))
    context = hazard_context(
        nodes,
        edges,
        scenario_hazards(db, scenario_id, organization_id),
        minutes_elapsed,
        horizon_minutes=params["hazard_risk_horizon_minutes"].value,
        risk_cost_metres=params["hazard_risk_cost_metres"].value,
        smoke_blocking_severity=params["smoke_blocking_severity"].value,
    )
    return context, params
