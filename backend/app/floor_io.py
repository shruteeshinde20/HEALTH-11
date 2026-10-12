"""Floor graph import and export (CSV, JSON, GeoJSON).

POST /floors/{id}/import  - body is the file; Content-Type selects the format:
                            text/csv, application/json, application/geo+json.
GET  /floors/{id}/export  - ?format=json|geojson|csv (default json).

Safety
- Body limited to 5 MiB, at most 5,000 nodes and 20,000 edges per import.
- Every value is validated (non-blank names, finite numbers).
- Malformed files always give 422, never a server error.
- CSV export neutralises spreadsheet formulas (cells starting with = + - @),
  and CSV import reverses that so a round trip keeps names unchanged.
- The import runs as one transaction: all rows are saved, or none.
"""

import csv
import io
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api_common import FiniteFloat, Name, NonNegativeFloat, PositiveFloat, get_active
from app.audit import record_audit
from app.db_session import get_db
from app.models.facility import Floor
from app.models.graph import Edge, Node, NodeType
from app.models.user import User
from app.permissions import Editor

router = APIRouter(tags=["Floor Import and Export"])

MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_NODES = 5_000
MAX_IMPORT_EDGES = 20_000

# Cells starting with these are run as formulas by Excel / LibreOffice.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


class ImportedNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name(150)
    type: NodeType
    x: FiniteFloat = 0.0
    y: FiniteFloat = 0.0
    capacity: Annotated[int, Field(ge=0, le=100_000)] = 0
    is_blocked: bool = False


class ImportedEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_node: Name(150)
    to_node: Name(150)
    distance: NonNegativeFloat
    width: PositiveFloat
    max_flow: Annotated[int, Field(gt=0, le=100_000)]
    wheelchair_accessible: bool = True
    stretcher_accessible: bool = True
    is_blocked: bool = False


class FloorImport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: Annotated[list[ImportedNode], Field(max_length=MAX_IMPORT_NODES)]
    edges: Annotated[list[ImportedEdge], Field(max_length=MAX_IMPORT_EDGES)]


def _parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise ValueError("Expected true or false")


def _csv_safe(value: Any) -> Any:
    """Prefix text that a spreadsheet would run as a formula with '."""
    if isinstance(value, str) and value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def _csv_unescape(value: str | None) -> str | None:
    if value and len(value) > 1 and value[0] == "'" and value[1:].startswith(_FORMULA_PREFIXES):
        return value[1:]
    return value


def _parse_csv(text: str) -> dict:
    nodes, edges = [], []
    for row in csv.DictReader(io.StringIO(text)):
        kind = (row.get("record_type") or "").strip().lower()
        if kind == "node":
            nodes.append({
                "name": _csv_unescape(row.get("name")),
                "type": row.get("type"),
                "x": float(row.get("x") or 0),
                "y": float(row.get("y") or 0),
                "capacity": int(row.get("capacity") or 0),
                "is_blocked": _parse_bool(row.get("is_blocked") or "false"),
            })
        elif kind == "edge":
            edges.append({
                "from_node": _csv_unescape(row.get("from_node")),
                "to_node": _csv_unescape(row.get("to_node")),
                "distance": float(row["distance"]),
                "width": float(row["width"]),
                "max_flow": int(row["max_flow"]),
                "wheelchair_accessible": _parse_bool(row.get("wheelchair_accessible") or "true"),
                "stretcher_accessible": _parse_bool(row.get("stretcher_accessible") or "true"),
                "is_blocked": _parse_bool(row.get("is_blocked") or "false"),
            })
        else:
            raise ValueError("record_type must be node or edge")
    return {"nodes": nodes, "edges": edges}


def _parse_geojson(payload: Any) -> dict:
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError("features must be a list")
    nodes, edges = [], []
    for feature in features:
        if not isinstance(feature, dict):
            raise ValueError("Each feature must be an object")
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            raise ValueError("properties and geometry must be objects")
        kind = properties.get("record_type")
        coordinates = geometry.get("coordinates")

        if kind == "node" and geometry.get("type") == "Point":
            if not isinstance(coordinates, list) or len(coordinates) < 2:
                raise ValueError("A Point needs [x, y] coordinates")
            nodes.append({
                "name": properties.get("name"),
                "type": properties.get("type"),
                "x": coordinates[0],
                "y": coordinates[1],
                "capacity": properties.get("capacity", 0),
                "is_blocked": properties.get("is_blocked", False),
            })
        elif kind == "edge" and geometry.get("type") == "LineString":
            edges.append({
                "from_node": properties.get("from_node"),
                "to_node": properties.get("to_node"),
                "distance": properties.get("distance"),
                "width": properties.get("width"),
                "max_flow": properties.get("max_flow"),
                "wheelchair_accessible": properties.get("wheelchair_accessible", True),
                "stretcher_accessible": properties.get("stretcher_accessible", True),
                "is_blocked": properties.get("is_blocked", False),
            })
        else:
            raise ValueError("Unsupported GeoJSON feature")
    return {"nodes": nodes, "edges": edges}


def _parse_content(content: bytes, content_type: str) -> FloorImport:
    if content_type not in {"text/csv", "application/json", "application/geo+json"}:
        raise HTTPException(
            status_code=415,
            detail="Use text/csv, application/json, or application/geo+json",
        )
    try:
        text = content.decode("utf-8-sig")
        if content_type == "text/csv":
            return FloorImport.model_validate(_parse_csv(text))

        payload = json.loads(text)
        if isinstance(payload, dict) and payload.get("type") == "FeatureCollection":
            return FloorImport.model_validate(_parse_geojson(payload))
        if content_type == "application/geo+json":
            raise ValueError("Expected a GeoJSON FeatureCollection")
        return FloorImport.model_validate(payload)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        csv.Error,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        AttributeError,
        ValidationError,
    ) as exc:
        raise HTTPException(status_code=422, detail="Invalid floor import data") from exc


def _save_import(
    db: Session, floor_id: int, data: FloorImport, content_type: str,
    user: User, request: Request,
) -> dict:
    get_active(db, Floor, floor_id, user.organization_id, "Floor")

    node_names = [node.name for node in data.nodes]
    if len(node_names) != len(set(node_names)):
        raise HTTPException(status_code=422, detail="Node names must be unique within the import")

    existing_nodes = db.scalars(
        select(Node).where(
            Node.floor_id == floor_id,
            Node.organization_id == user.organization_id,
            Node.deleted_at.is_(None),
        )
    ).all()
    known_names = {node.name for node in existing_nodes}
    if known_names.intersection(node_names):
        raise HTTPException(status_code=409, detail="An imported node name already exists on this floor")

    all_names = known_names | set(node_names)
    for edge in data.edges:
        if edge.from_node not in all_names or edge.to_node not in all_names or edge.from_node == edge.to_node:
            raise HTTPException(status_code=422, detail="An edge references a missing or identical node")

    # Edges are undirected: A-B and B-A are the same edge.
    pairs = [frozenset((edge.from_node, edge.to_node)) for edge in data.edges]
    if len(pairs) != len(set(pairs)):
        raise HTTPException(status_code=422, detail="Duplicate edges are not allowed")

    try:
        nodes_by_name = {node.name: node for node in existing_nodes}
        for item in data.nodes:
            node = Node(organization_id=user.organization_id, floor_id=floor_id, **item.model_dump())
            db.add(node)
            nodes_by_name[item.name] = node
        db.flush()

        # One query for all existing edges on this floor (no query per edge).
        existing_ids = [node.id for node in existing_nodes]
        existing_pairs = set()
        if existing_ids:
            existing_pairs = {
                frozenset(pair) for pair in db.execute(
                    select(Edge.from_node_id, Edge.to_node_id).where(
                        Edge.organization_id == user.organization_id,
                        Edge.deleted_at.is_(None),
                        Edge.from_node_id.in_(existing_ids),
                        Edge.to_node_id.in_(existing_ids),
                    )
                )
            }

        for item in data.edges:
            source = nodes_by_name[item.from_node]
            target = nodes_by_name[item.to_node]
            if frozenset((source.id, target.id)) in existing_pairs:
                raise HTTPException(status_code=409, detail="An imported edge already exists")
            db.add(Edge(
                organization_id=user.organization_id,
                from_node_id=source.id,
                to_node_id=target.id,
                **item.model_dump(exclude={"from_node", "to_node"}),
            ))

        record_audit(
            db, organization_id=user.organization_id, actor_user_id=user.id,
            action="floor.imported", entity_type="floor", entity_id=floor_id,
            request=request,
            details={
                "format": content_type,
                "nodes_imported": len(data.nodes),
                "edges_imported": len(data.edges),
            },
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Import conflicts with existing database records") from exc
    except Exception:
        db.rollback()
        raise

    return {
        "floor_id": floor_id,
        "nodes_imported": len(data.nodes),
        "edges_imported": len(data.edges),
    }


@router.post("/floors/{floor_id}/import", status_code=201)
async def import_floor(
    floor_id: int,
    request: Request,
    user: Editor,
    db: Session = Depends(get_db),
):
    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > MAX_IMPORT_BYTES:
            raise HTTPException(status_code=413, detail="Import file exceeds the 5 MiB limit")
        chunks.append(chunk)

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    content = b"".join(chunks)

    # Parsing and database work are blocking; run them off the event loop so
    # one large import does not stall every other request.
    data = await run_in_threadpool(_parse_content, content, content_type)
    return await run_in_threadpool(_save_import, db, floor_id, data, content_type, user, request)


@router.get("/floors/{floor_id}/export")
def export_floor(
    floor_id: int,
    user: Editor,
    export_format: Annotated[str, Query(alias="format")] = "json",
    db: Session = Depends(get_db),
):
    if export_format not in {"json", "geojson", "csv"}:
        raise HTTPException(status_code=422, detail="format must be json, geojson, or csv")
    get_active(db, Floor, floor_id, user.organization_id, "Floor")

    nodes = db.scalars(
        select(Node).where(
            Node.floor_id == floor_id,
            Node.organization_id == user.organization_id,
            Node.deleted_at.is_(None),
        ).order_by(Node.id)
    ).all()
    node_by_id = {node.id: node for node in nodes}

    edges = db.scalars(
        select(Edge).where(
            Edge.organization_id == user.organization_id,
            Edge.deleted_at.is_(None),
            Edge.from_node_id.in_(node_by_id.keys()),
            Edge.to_node_id.in_(node_by_id.keys()),
        ).order_by(Edge.id)
    ).all() if nodes else []

    node_records = [{
        "name": node.name,
        "type": node.type.value,
        "x": node.x,
        "y": node.y,
        "capacity": node.capacity,
        "is_blocked": node.is_blocked,
    } for node in nodes]

    edge_records = [{
        "from_node": node_by_id[edge.from_node_id].name,
        "to_node": node_by_id[edge.to_node_id].name,
        "distance": edge.distance,
        "width": edge.width,
        "max_flow": edge.max_flow,
        "wheelchair_accessible": edge.wheelchair_accessible,
        "stretcher_accessible": edge.stretcher_accessible,
        "is_blocked": edge.is_blocked,
    } for edge in edges]

    if export_format == "json":
        body = json.dumps({"nodes": node_records, "edges": edge_records})
        media_type = "application/json"
        filename = f"floor-{floor_id}.json"

    elif export_format == "geojson":
        features = [{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [node.x, node.y]},
            "properties": {"record_type": "node", **record},
        } for node, record in zip(nodes, node_records)]
        for edge, record in zip(edges, edge_records):
            source = node_by_id[edge.from_node_id]
            target = node_by_id[edge.to_node_id]
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[source.x, source.y], [target.x, target.y]],
                },
                "properties": {"record_type": "edge", **record},
            })
        body = json.dumps({"type": "FeatureCollection", "features": features})
        media_type = "application/geo+json"
        filename = f"floor-{floor_id}.geojson"

    else:
        output = io.StringIO()
        fields = [
            "record_type", "name", "type", "x", "y", "capacity",
            "is_blocked", "from_node", "to_node", "distance", "width",
            "max_flow", "wheelchair_accessible", "stretcher_accessible",
        ]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for record in node_records:
            writer.writerow({"record_type": "node", **{k: _csv_safe(v) for k, v in record.items()}})
        for record in edge_records:
            writer.writerow({"record_type": "edge", **{k: _csv_safe(v) for k, v in record.items()}})
        body = output.getvalue()
        media_type = "text/csv"
        filename = f"floor-{floor_id}.csv"

    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
