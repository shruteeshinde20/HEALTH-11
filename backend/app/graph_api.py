from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db_session import get_db
from app.models.facility import Floor
from app.models.graph import Edge, Node, NodeType
from app.models.user import User

router = APIRouter(prefix="/graph", tags=["Hospital Graph"])

Db = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


# Request schemas

class NodeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    type: NodeType
    x: float = 0.0
    y: float = 0.0
    capacity: int = Field(default=0, ge=0)
    is_blocked: bool = False


class NodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    type: NodeType | None = None
    x: float | None = None
    y: float | None = None
    capacity: int | None = Field(default=None, ge=0)
    is_blocked: bool | None = None


class EdgeCreate(BaseModel):
    from_node_id: int = Field(gt=0)
    to_node_id: int = Field(gt=0)
    distance: float = Field(ge=0)
    width: float = Field(gt=0)
    max_flow: int = Field(gt=0)
    wheelchair_accessible: bool = True
    stretcher_accessible: bool = True
    is_blocked: bool = False


class EdgeUpdate(BaseModel):
    distance: float | None = Field(default=None, ge=0)
    width: float | None = Field(default=None, gt=0)
    max_flow: int | None = Field(default=None, gt=0)
    wheelchair_accessible: bool | None = None
    stretcher_accessible: bool | None = None
    is_blocked: bool | None = None


# Response schemas

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


class FloorGraphOut(BaseModel):
    floor_id: int
    nodes: list[NodeOut]
    edges: list[EdgeOut]


# Organization-scoped database lookups

def _require_floor(
    db: Session, floor_id: int, organization_id: int
) -> Floor:
    floor = db.scalar(
        select(Floor).where(
            Floor.id == floor_id,
            Floor.organization_id == organization_id,
            Floor.deleted_at.is_(None),
        )
    )
    if floor is None:
        raise HTTPException(status_code=404, detail="Floor not found")
    return floor


def _require_node(
    db: Session, node_id: int, organization_id: int
) -> Node:
    node = db.scalar(
        select(Node).where(
            Node.id == node_id,
            Node.organization_id == organization_id,
            Node.deleted_at.is_(None),
        )
    )
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


def _require_edge(
    db: Session, edge_id: int, organization_id: int
) -> Edge:
    edge = db.scalar(
        select(Edge).where(
            Edge.id == edge_id,
            Edge.organization_id == organization_id,
            Edge.deleted_at.is_(None),
        )
    )
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    return edge


def _commit_or_conflict(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="The change conflicts with existing database records",
        ) from exc


# Read all nodes and edges for one floor

@router.get(
    "/floors/{floor_id}",
    response_model=FloorGraphOut,
)
def get_floor_graph(
    floor_id: int,
    db: Db,
    user: CurrentUser,
) -> FloorGraphOut:
    _require_floor(db, floor_id, user.organization_id)

    nodes = list(
        db.scalars(
            select(Node)
            .where(
                Node.floor_id == floor_id,
                Node.organization_id == user.organization_id,
                Node.deleted_at.is_(None),
            )
            .order_by(Node.id)
        ).all()
    )

    node_ids = [node.id for node in nodes]
    edges = []

    if node_ids:
        edges = list(
            db.scalars(
                select(Edge)
                .where(
                    Edge.organization_id == user.organization_id,
                    Edge.from_node_id.in_(node_ids),
                    Edge.to_node_id.in_(node_ids),
                    Edge.deleted_at.is_(None),
                )
                .order_by(Edge.id)
            ).all()
        )

    return FloorGraphOut(
        floor_id=floor_id,
        nodes=nodes,
        edges=edges,
    )


# Create a graph node

@router.post(
    "/floors/{floor_id}/nodes",
    response_model=NodeOut,
    status_code=status.HTTP_201_CREATED,
)
def create_node(
    floor_id: int,
    payload: NodeCreate,
    db: Db,
    user: CurrentUser,
) -> Node:
    _require_floor(db, floor_id, user.organization_id)

    node = Node(
        organization_id=user.organization_id,
        floor_id=floor_id,
        **payload.model_dump(),
    )
    db.add(node)
    _commit_or_conflict(db)
    db.refresh(node)
    return node


# Update a graph node

@router.patch("/nodes/{node_id}", response_model=NodeOut)
def update_node(
    node_id: int,
    payload: NodeUpdate,
    db: Db,
    user: CurrentUser,
) -> Node:
    node = _require_node(db, node_id, user.organization_id)
    changes = payload.model_dump(exclude_unset=True)

    if not changes:
        raise HTTPException(status_code=422, detail="No fields supplied")

    if any(value is None for value in changes.values()):
        raise HTTPException(status_code=422, detail="Fields cannot be null")

    for field, value in changes.items():
        setattr(node, field, value)

    _commit_or_conflict(db)
    db.refresh(node)
    return node


# Create an edge between two nodes on the same floor

@router.post(
    "/floors/{floor_id}/edges",
    response_model=EdgeOut,
    status_code=status.HTTP_201_CREATED,
)
def create_edge(
    floor_id: int,
    payload: EdgeCreate,
    db: Db,
    user: CurrentUser,
) -> Edge:
    _require_floor(db, floor_id, user.organization_id)

    if payload.from_node_id == payload.to_node_id:
        raise HTTPException(
            status_code=422,
            detail="An edge must connect two different nodes",
        )

    node_ids = {payload.from_node_id, payload.to_node_id}
    nodes = list(
        db.scalars(
            select(Node).where(
                Node.id.in_(node_ids),
                Node.floor_id == floor_id,
                Node.organization_id == user.organization_id,
                Node.deleted_at.is_(None),
            )
        ).all()
    )

    if {node.id for node in nodes} != node_ids:
        raise HTTPException(
            status_code=422,
            detail="Both edge endpoints must belong to this floor and organization",
        )

    edge = Edge(
        organization_id=user.organization_id,
        **payload.model_dump(),
    )
    db.add(edge)
    _commit_or_conflict(db)
    db.refresh(edge)
    return edge


# Update an edge

@router.patch("/edges/{edge_id}", response_model=EdgeOut)
def update_edge(
    edge_id: int,
    payload: EdgeUpdate,
    db: Db,
    user: CurrentUser,
) -> Edge:
    edge = _require_edge(db, edge_id, user.organization_id)
    changes = payload.model_dump(exclude_unset=True)

    if not changes:
        raise HTTPException(status_code=422, detail="No fields supplied")

    if any(value is None for value in changes.values()):
        raise HTTPException(status_code=422, detail="Fields cannot be null")

    for field, value in changes.items():
        setattr(edge, field, value)

    _commit_or_conflict(db)
    db.refresh(edge)
    return edge

from app.services.routing import (
    InvalidRouteRequest,
    NoRouteError,
    find_route,
    nearest_safe_exit,
)


# Evacuation route request and response schemas

class RouteRequest(BaseModel):
    start: int | str
    destination: int | str | None = None
    mobility: str = "ambulatory"
    algorithm: str = "astar"


class RouteOut(BaseModel):
    node_ids: list[int]
    node_names: list[str]
    distance_metres: float
    algorithm: str


def _calculate_floor_route(
    floor_id: int,
    start: int | str,
    destination: int | str | None,
    mobility: str,
    algorithm: str,
    db: Session,
    user: User,
) -> RouteOut:
    _require_floor(db, floor_id, user.organization_id)

    nodes = list(
        db.scalars(
            select(Node)
            .where(
                Node.floor_id == floor_id,
                Node.organization_id == user.organization_id,
                Node.deleted_at.is_(None),
            )
            .order_by(Node.id)
        ).all()
    )

    node_ids = [node.id for node in nodes]
    edges = []

    if node_ids:
        edges = list(
            db.scalars(
                select(Edge)
                .where(
                    Edge.organization_id == user.organization_id,
                    Edge.from_node_id.in_(node_ids),
                    Edge.to_node_id.in_(node_ids),
                    Edge.deleted_at.is_(None),
                )
                .order_by(Edge.id)
            ).all()
        )

    try:
        if destination is None:
            result = nearest_safe_exit(
                nodes,
                edges,
                start,
                mobility=mobility,
                algorithm=algorithm,
            )
        else:
            result = find_route(
                nodes,
                edges,
                start,
                destination,
                mobility=mobility,
                algorithm=algorithm,
            )
    except InvalidRouteRequest as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except NoRouteError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return RouteOut(
        node_ids=result.node_ids,
        node_names=result.node_names,
        distance_metres=result.distance_metres,
        algorithm=result.algorithm,
    )


@router.post(
    "/floors/{floor_id}/route",
    response_model=RouteOut,
)
def calculate_evacuation_route(
    floor_id: int,
    payload: RouteRequest,
    db: Db,
    user: CurrentUser,
) -> RouteOut:
    return _calculate_floor_route(
        floor_id=floor_id,
        start=payload.start,
        destination=payload.destination,
        mobility=payload.mobility,
        algorithm=payload.algorithm,
        db=db,
        user=user,
    )
