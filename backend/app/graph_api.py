"""Nodes and edges (PROJECT.md API contract), plus floor graph and route.

- /nodes and /edges: GET list (?floor_id=), GET /{id}, POST, PATCH /{id},
  DELETE /{id} (soft delete).
- Edges are undirected. Both nodes must be in the same building; an edge
  between two floors must join vertical connectors (stair, ramp or lift).
- GET /floors/{id}/graph and POST /floors/{id}/route are read helpers for
  the Graph Builder and Live Simulation pages.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api_common import (
    FiniteFloat,
    Id,
    Name,
    NonNegativeFloat,
    Page,
    PageParams,
    PositiveFloat,
    SearchQuery,
    changes_from,
    commit_or_conflict,
    contains,
    ensure_none_active,
    flush_or_conflict,
    get_active,
    page_params,
    paginate,
    require_reference,
)
from app.audit import record_audit
from app.db_session import get_db
from app.models.facility import Floor
from app.models.graph import VERTICAL_NODE_TYPES, Edge, Node, NodeType
from app.models.operations import Hazard, Patient, Scenario, Staff
from app.permissions import Editor, Reader
from app.services.scenario_inputs import building_nodes_and_edges, scenario_hazard_context
from app.services.routing import (
    InvalidRouteRequest,
    NoRouteError,
    find_route,
    nearest_safe_exit,
)

router = APIRouter(tags=["Hospital Graph"])

Db = Annotated[Session, Depends(get_db)]
Paging = Annotated[PageParams, Depends(page_params)]

NODE_CONFLICT = "A node with this name already exists on this floor"
EDGE_CONFLICT = "These two nodes are already connected by an edge"


# --- Schemas ---------------------------------------------------------------------------

Capacity = Annotated[int, Field(ge=0, le=100_000)]
MaxFlow = Annotated[int, Field(gt=0, le=100_000)]


class NodeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    floor_id: Id
    name: Name(150)
    type: NodeType
    x: FiniteFloat = 0.0
    y: FiniteFloat = 0.0
    capacity: Capacity = 0
    is_blocked: bool = False
    is_evacuation_lift: bool = False


class NodeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name(150) | None = None
    type: NodeType | None = None
    x: FiniteFloat | None = None
    y: FiniteFloat | None = None
    capacity: Capacity | None = None
    is_blocked: bool | None = None
    is_evacuation_lift: bool | None = None


class NodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    floor_id: int
    name: str
    type: NodeType
    x: float
    y: float
    capacity: int
    is_blocked: bool
    is_evacuation_lift: bool
    created_at: datetime
    updated_at: datetime


EVACUATION_LIFT_ONLY = "Only a node of type 'lift' can be an evacuation lift"


class EdgeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_node_id: Id
    to_node_id: Id
    distance: NonNegativeFloat
    width: PositiveFloat
    max_flow: MaxFlow
    wheelchair_accessible: bool = True
    stretcher_accessible: bool = True
    is_blocked: bool = False


class EdgeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    distance: NonNegativeFloat | None = None
    width: PositiveFloat | None = None
    max_flow: MaxFlow | None = None
    wheelchair_accessible: bool | None = None
    stretcher_accessible: bool | None = None
    is_blocked: bool | None = None


class EdgeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    organization_id: int
    from_node_id: int
    to_node_id: int
    distance: float
    width: float
    max_flow: int
    wheelchair_accessible: bool
    stretcher_accessible: bool
    is_blocked: bool
    created_at: datetime
    updated_at: datetime


class FloorGraphOut(BaseModel):
    floor_id: int
    nodes: list[NodeOut]
    edges: list[EdgeOut]


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: Annotated[int, Field(gt=0, strict=True)] | Name(150)
    destination: Annotated[int, Field(gt=0, strict=True)] | Name(150) | None = None
    mobility: str = "ambulatory"
    algorithm: str = "astar"
    # Optional: route around the hazards of a scenario at a given time.
    scenario_id: Id | None = None
    minutes_elapsed: Annotated[float, Field(ge=0, le=1440, allow_inf_nan=False)] = 0.0


class RouteOut(BaseModel):
    node_ids: list[int]
    node_names: list[str]
    floor_ids: list[int]
    distance_metres: float
    risk_cost_metres: float
    algorithm: str
    mobility: str
    scenario_id: int | None
    minutes_elapsed: float
    lifts_disabled: bool


def _audit(db, user, request, action, entity_type, entity_id, details=None):
    record_audit(
        db, organization_id=user.organization_id, actor_user_id=user.id,
        action=action, entity_type=entity_type, entity_id=entity_id,
        request=request, details=details,
    )


def _floor_nodes_and_edges(db: Session, floor_id: int, organization_id: int):
    nodes = list(db.scalars(
        select(Node).where(
            Node.floor_id == floor_id,
            Node.organization_id == organization_id,
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


def _cross_floor_edge_count(db: Session, node: Node) -> int:
    """Active edges joining `node` to a node on another floor."""
    other = select(Node.id).where(
        Node.organization_id == node.organization_id, Node.floor_id != node.floor_id
    )
    return db.scalar(
        select(func.count()).select_from(Edge).where(
            Edge.organization_id == node.organization_id,
            Edge.deleted_at.is_(None),
            or_(
                (Edge.from_node_id == node.id) & Edge.to_node_id.in_(other),
                (Edge.to_node_id == node.id) & Edge.from_node_id.in_(other),
            ),
        )
    ) or 0


# --- Nodes ----------------------------------------------------------------------------------

@router.get("/nodes", response_model=Page[NodeOut])
def list_nodes(
    db: Db, user: Reader, paging: Paging, q: SearchQuery = None,
    floor_id: Annotated[int | None, Query(gt=0)] = None,
    type: NodeType | None = None,
):
    stmt = select(Node).where(
        Node.organization_id == user.organization_id, Node.deleted_at.is_(None)
    )
    if floor_id is not None:
        stmt = stmt.where(Node.floor_id == floor_id)
    if type is not None:
        stmt = stmt.where(Node.type == type)
    if (match := contains(Node.name, q)) is not None:
        stmt = stmt.where(match)
    return paginate(db, stmt, paging, Node.floor_id, Node.name, Node.id)


@router.get("/nodes/{node_id}", response_model=NodeOut)
def get_node(node_id: int, db: Db, user: Reader):
    return get_active(db, Node, node_id, user.organization_id, "Node")


@router.post("/nodes", response_model=NodeOut, status_code=status.HTTP_201_CREATED)
def create_node(payload: NodeCreate, db: Db, user: Editor, request: Request):
    if payload.is_evacuation_lift and payload.type != NodeType.LIFT:
        raise HTTPException(status_code=422, detail=EVACUATION_LIFT_ONLY)
    require_reference(db, Floor, payload.floor_id, user.organization_id, "Floor")
    node = Node(organization_id=user.organization_id, **payload.model_dump())
    db.add(node)
    flush_or_conflict(db, NODE_CONFLICT)
    _audit(db, user, request, "node.created", "node", node.id, {"floor_id": node.floor_id})
    commit_or_conflict(db, NODE_CONFLICT)
    db.refresh(node)
    return node


@router.patch("/nodes/{node_id}", response_model=NodeOut)
def update_node(node_id: int, payload: NodeUpdate, db: Db, user: Editor, request: Request):
    node = get_active(db, Node, node_id, user.organization_id, "Node")
    changes = changes_from(payload, not_null=set(NodeUpdate.model_fields))
    new_type = changes.get("type")
    final_type = new_type or node.type
    final_flag = changes.get("is_evacuation_lift", node.is_evacuation_lift)
    if final_flag and final_type != NodeType.LIFT:
        raise HTTPException(status_code=422, detail=EVACUATION_LIFT_ONLY)
    if (
        new_type is not None
        and new_type not in VERTICAL_NODE_TYPES
        and _cross_floor_edge_count(db, node)
    ):
        raise HTTPException(
            status_code=409,
            detail="This node links two floors; it must stay a stair, ramp or lift "
            "until those edges are deleted",
        )
    for field, value in changes.items():
        setattr(node, field, value)
    flush_or_conflict(db, NODE_CONFLICT)
    _audit(db, user, request, "node.updated", "node", node.id, {"fields": sorted(changes)})
    commit_or_conflict(db, NODE_CONFLICT)
    db.refresh(node)
    return node


@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(node_id: int, db: Db, user: Editor, request: Request):
    node = get_active(db, Node, node_id, user.organization_id, "Node")
    for model, column, label in (
        (Patient, Patient.node_id, "patients"),
        (Staff, Staff.node_id, "staff"),
        (Hazard, Hazard.origin_node_id, "hazards"),
    ):
        ensure_none_active(
            db, model, column == node.id,
            f"Move or delete the {label} at this node first",
        )
    # Edges cannot exist without both nodes, so they are removed with it.
    removed = db.execute(
        update(Edge)
        .where(
            Edge.organization_id == user.organization_id,
            Edge.deleted_at.is_(None),
            or_(Edge.from_node_id == node.id, Edge.to_node_id == node.id),
        )
        .values(deleted_at=func.now())
    ).rowcount
    node.deleted_at = func.now()
    _audit(db, user, request, "node.deleted", "node", node.id, {"edges_deleted": removed})
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Edges ---------------------------------------------------------------------------------

@router.get("/edges", response_model=Page[EdgeOut])
def list_edges(
    db: Db, user: Reader, paging: Paging,
    floor_id: Annotated[int | None, Query(gt=0)] = None,
    node_id: Annotated[int | None, Query(gt=0)] = None,
):
    stmt = select(Edge).where(
        Edge.organization_id == user.organization_id, Edge.deleted_at.is_(None)
    )
    if floor_id is not None:
        on_floor = select(Node.id).where(
            Node.organization_id == user.organization_id, Node.floor_id == floor_id
        )
        # Includes edges that leave the floor (stairs, ramps, lifts).
        stmt = stmt.where(or_(Edge.from_node_id.in_(on_floor), Edge.to_node_id.in_(on_floor)))
    if node_id is not None:
        stmt = stmt.where(or_(Edge.from_node_id == node_id, Edge.to_node_id == node_id))
    return paginate(db, stmt, paging, Edge.id)


@router.get("/edges/{edge_id}", response_model=EdgeOut)
def get_edge(edge_id: int, db: Db, user: Reader):
    return get_active(db, Edge, edge_id, user.organization_id, "Edge")


@router.post("/edges", response_model=EdgeOut, status_code=status.HTTP_201_CREATED)
def create_edge(payload: EdgeCreate, db: Db, user: Editor, request: Request):
    if payload.from_node_id == payload.to_node_id:
        raise HTTPException(status_code=422, detail="An edge must connect two different nodes")
    start = require_reference(db, Node, payload.from_node_id, user.organization_id, "Node")
    end = require_reference(db, Node, payload.to_node_id, user.organization_id, "Node")

    if start.floor_id != end.floor_id:
        floors = {
            floor.id: floor for floor in db.scalars(
                select(Floor).where(Floor.id.in_([start.floor_id, end.floor_id]))
            )
        }
        if floors[start.floor_id].building_id != floors[end.floor_id].building_id:
            raise HTTPException(
                status_code=422, detail="Both nodes must be in the same building"
            )
        if start.type not in VERTICAL_NODE_TYPES or end.type not in VERTICAL_NODE_TYPES:
            raise HTTPException(
                status_code=422,
                detail="An edge between floors must join two stairs, ramps or lifts",
            )

    edge = Edge(organization_id=user.organization_id, **payload.model_dump())
    db.add(edge)
    flush_or_conflict(db, EDGE_CONFLICT)
    _audit(db, user, request, "edge.created", "edge", edge.id,
           {"from_node_id": edge.from_node_id, "to_node_id": edge.to_node_id})
    commit_or_conflict(db, EDGE_CONFLICT)
    db.refresh(edge)
    return edge


@router.patch("/edges/{edge_id}", response_model=EdgeOut)
def update_edge(edge_id: int, payload: EdgeUpdate, db: Db, user: Editor, request: Request):
    edge = get_active(db, Edge, edge_id, user.organization_id, "Edge")
    changes = changes_from(payload, not_null=set(EdgeUpdate.model_fields))
    for field, value in changes.items():
        setattr(edge, field, value)
    flush_or_conflict(db, EDGE_CONFLICT)
    _audit(db, user, request, "edge.updated", "edge", edge.id, {"fields": sorted(changes)})
    commit_or_conflict(db, EDGE_CONFLICT)
    db.refresh(edge)
    return edge


@router.delete("/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(edge_id: int, db: Db, user: Editor, request: Request):
    edge = get_active(db, Edge, edge_id, user.organization_id, "Edge")
    edge.deleted_at = func.now()
    _audit(db, user, request, "edge.deleted", "edge", edge.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Floor graph and route ------------------------------------------------------------------

@router.get("/floors/{floor_id}/graph", response_model=FloorGraphOut)
def get_floor_graph(floor_id: int, db: Db, user: Reader):
    get_active(db, Floor, floor_id, user.organization_id, "Floor")
    nodes, edges = _floor_nodes_and_edges(db, floor_id, user.organization_id)
    return FloorGraphOut(floor_id=floor_id, nodes=nodes, edges=edges)


@router.post("/floors/{floor_id}/route", response_model=RouteOut)
def calculate_evacuation_route(floor_id: int, payload: RouteRequest, db: Db, user: Reader):
    """Route from a node on this floor, through the whole building.

    `start` (and `destination`, if given) is a node ID or exact name. A name
    is looked up on this floor first. Without `destination`, the route goes
    to the nearest usable exit in the building.
    """
    floor = get_active(db, Floor, floor_id, user.organization_id, "Floor")
    nodes, edges = building_nodes_and_edges(db, floor.building_id, user.organization_id)
    hazard = None
    if payload.scenario_id is not None:
        require_reference(db, Scenario, payload.scenario_id, user.organization_id, "Scenario")
        hazard, _ = scenario_hazard_context(
            db, user.organization_id, payload.scenario_id, nodes, edges, payload.minutes_elapsed,
        )
    try:
        if payload.destination is None:
            result = nearest_safe_exit(
                nodes, edges, payload.start,
                mobility=payload.mobility, algorithm=payload.algorithm,
                start_floor_id=floor_id, hazard=hazard,
            )
        else:
            result = find_route(
                nodes, edges, payload.start, payload.destination,
                mobility=payload.mobility, algorithm=payload.algorithm,
                start_floor_id=floor_id, hazard=hazard,
            )
    except (InvalidRouteRequest, NoRouteError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RouteOut(
        node_ids=result.node_ids,
        node_names=result.node_names,
        floor_ids=result.floor_ids,
        distance_metres=result.distance_metres,
        risk_cost_metres=result.risk_cost_metres,
        algorithm=result.algorithm,
        mobility=payload.mobility.lower(),
        scenario_id=payload.scenario_id,
        minutes_elapsed=payload.minutes_elapsed,
        lifts_disabled=bool(hazard and hazard.lifts_disabled),
    )
