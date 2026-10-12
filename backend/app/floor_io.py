import csv
import io
import json
import math

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.db_session import get_db
from app.models.facility import Floor
from app.models.graph import Edge, Node, NodeType
from app.permissions import Editor

router = APIRouter(tags=["Floor Import and Export"])

MAX_IMPORT_BYTES = 5 * 1024 * 1024


class ImportedNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=150)
    type: NodeType
    x: float = 0.0
    y: float = 0.0
    capacity: int = Field(default=0, ge=0)
    is_blocked: bool = False


class ImportedEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_node: str = Field(min_length=1, max_length=150)
    to_node: str = Field(min_length=1, max_length=150)
    distance: float = Field(ge=0)
    width: float = Field(gt=0)
    max_flow: int = Field(gt=0)
    wheelchair_accessible: bool = True
    stretcher_accessible: bool = True
    is_blocked: bool = False


class FloorImport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodes: list[ImportedNode]
    edges: list[ImportedEdge]


def _floor_or_404(
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


def _finite_coordinates(data: FloorImport) -> None:
    for node in data.nodes:
        if not math.isfinite(node.x) or not math.isfinite(node.y):
            raise HTTPException(
                status_code=422,
                detail="Node coordinates must be finite numbers",
            )


def _parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise ValueError("Expected true or false")


def _parse_content(content: bytes, content_type: str) -> FloorImport:
    try:
        text = content.decode("utf-8-sig")

        if content_type == "text/csv":
            rows = list(csv.DictReader(io.StringIO(text)))
            nodes = []
            edges = []

            for row in rows:
                kind = (row.get("record_type") or "").strip().lower()

                if kind == "node":
                    nodes.append({
                        "name": row.get("name"),
                        "type": row.get("type"),
                        "x": float(row.get("x") or 0),
                        "y": float(row.get("y") or 0),
                        "capacity": int(row.get("capacity") or 0),
                        "is_blocked": _parse_bool(
                            row.get("is_blocked") or "false"
                        ),
                    })
                elif kind == "edge":
                    edges.append({
                        "from_node": row.get("from_node"),
                        "to_node": row.get("to_node"),
                        "distance": float(row["distance"]),
                        "width": float(row["width"]),
                        "max_flow": int(row["max_flow"]),
                        "wheelchair_accessible": _parse_bool(
                            row.get("wheelchair_accessible") or "true"
                        ),
                        "stretcher_accessible": _parse_bool(
                            row.get("stretcher_accessible") or "true"
                        ),
                        "is_blocked": _parse_bool(
                            row.get("is_blocked") or "false"
                        ),
                    })
                else:
                    raise ValueError(
                        "record_type must be node or edge"
                    )

            data = FloorImport(nodes=nodes, edges=edges)

        elif content_type in {
            "application/json",
            "application/geo+json",
        }:
            payload = json.loads(text)

            if isinstance(payload, dict) and payload.get("type") == "FeatureCollection":
                nodes = []
                edges = []

                for feature in payload.get("features", []):
                    properties = feature.get("properties") or {}
                    geometry = feature.get("geometry") or {}
                    kind = properties.get("record_type")
                    coordinates = geometry.get("coordinates")

                    if kind == "node" and geometry.get("type") == "Point":
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
                            "wheelchair_accessible": properties.get(
                                "wheelchair_accessible", True
                            ),
                            "stretcher_accessible": properties.get(
                                "stretcher_accessible", True
                            ),
                            "is_blocked": properties.get("is_blocked", False),
                        })
                    else:
                        raise ValueError("Unsupported GeoJSON feature")

                data = FloorImport(nodes=nodes, edges=edges)
            else:
                if content_type == "application/geo+json":
                    raise ValueError("Expected a GeoJSON FeatureCollection")
                data = FloorImport.model_validate(payload)
        else:
            raise HTTPException(
                status_code=415,
                detail="Use text/csv, application/json, or application/geo+json",
            )

        _finite_coordinates(data)
        return data

    except HTTPException:
        raise
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        csv.Error,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        ValidationError,
    ) as exc:
        raise HTTPException(
            status_code=422,
            detail="Invalid floor import data",
        ) from exc


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
            raise HTTPException(
                status_code=413,
                detail="Import file exceeds the 5 MiB limit",
            )

        chunks.append(chunk)

    content = b"".join(chunks)

    content_type = request.headers.get(
        "content-type", ""
    ).split(";", 1)[0].strip().lower()

    data = _parse_content(content, content_type)
    _floor_or_404(db, floor_id, user.organization_id)

    node_names = [node.name for node in data.nodes]
    if len(node_names) != len(set(node_names)):
        raise HTTPException(
            status_code=422,
            detail="Node names must be unique within the import",
        )

    existing_nodes = db.scalars(
        select(Node).where(
            Node.floor_id == floor_id,
            Node.organization_id == user.organization_id,
            Node.deleted_at.is_(None),
        )
    ).all()
    known_names = {node.name for node in existing_nodes}

    if known_names.intersection(node_names):
        raise HTTPException(
            status_code=409,
            detail="An imported node name already exists on this floor",
        )

    all_names = known_names | set(node_names)
    for edge in data.edges:
        if (
            edge.from_node not in all_names
            or edge.to_node not in all_names
            or edge.from_node == edge.to_node
        ):
            raise HTTPException(
                status_code=422,
                detail="An edge references a missing or identical node",
            )

    edge_pairs = [
        (edge.from_node, edge.to_node) for edge in data.edges
    ]
    if len(edge_pairs) != len(set(edge_pairs)):
        raise HTTPException(
            status_code=422,
            detail="Duplicate directed edges are not allowed",
        )

    try:
        nodes_by_name = {node.name: node for node in existing_nodes}

        for item in data.nodes:
            node = Node(
                organization_id=user.organization_id,
                floor_id=floor_id,
                **item.model_dump(),
            )
            db.add(node)
            nodes_by_name[item.name] = node

        db.flush()

        existing_ids = {
            node.id for node in existing_nodes
        }
        seen_pairs = set()

        for item in data.edges:
            source = nodes_by_name[item.from_node]
            target = nodes_by_name[item.to_node]
            pair = (source.id, target.id)

            if pair in seen_pairs:
                raise HTTPException(
                    status_code=422,
                    detail="Duplicate directed edges are not allowed",
                )
            seen_pairs.add(pair)

            duplicate = db.scalar(
                select(Edge.id).where(
                    Edge.organization_id == user.organization_id,
                    Edge.from_node_id == source.id,
                    Edge.to_node_id == target.id,
                    Edge.deleted_at.is_(None),
                )
            )
            if duplicate is not None:
                raise HTTPException(
                    status_code=409,
                    detail="An imported edge already exists",
                )

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
        raise HTTPException(
            status_code=409,
            detail="Import conflicts with existing database records",
        ) from exc
    except Exception:
        db.rollback()
        raise

    return {
        "floor_id": floor_id,
        "nodes_imported": len(data.nodes),
        "edges_imported": len(data.edges),
    }


@router.get("/floors/{floor_id}/export")
def export_floor(
    floor_id: int,
    user: Editor,
    format: str = "json",
    db: Session = Depends(get_db),
):
    _floor_or_404(db, floor_id, user.organization_id)

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

    if format == "json":
        body = json.dumps({
            "nodes": node_records,
            "edges": edge_records,
        })
        media_type = "application/json"
        filename = f"floor-{floor_id}.json"

    elif format == "geojson":
        features = []
        for node in nodes:
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [node.x, node.y],
                },
                "properties": {
                    "record_type": "node",
                    **node_records[nodes.index(node)],
                },
            })

        for edge, record in zip(edges, edge_records):
            source = node_by_id[edge.from_node_id]
            target = node_by_id[edge.to_node_id]
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [source.x, source.y],
                        [target.x, target.y],
                    ],
                },
                "properties": {
                    "record_type": "edge",
                    **record,
                },
            })

        body = json.dumps({
            "type": "FeatureCollection",
            "features": features,
        })
        media_type = "application/geo+json"
        filename = f"floor-{floor_id}.geojson"

    elif format == "csv":
        output = io.StringIO()
        fields = [
            "record_type", "name", "type", "x", "y", "capacity",
            "is_blocked", "from_node", "to_node", "distance", "width",
            "max_flow", "wheelchair_accessible", "stretcher_accessible",
        ]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()

        for node in node_records:
            writer.writerow({"record_type": "node", **node})

        for edge in edge_records:
            writer.writerow({"record_type": "edge", **edge})

        body = output.getvalue()
        media_type = "text/csv"
        filename = f"floor-{floor_id}.csv"

    else:
        raise HTTPException(
            status_code=422,
            detail="format must be json, geojson, or csv",
        )

    return Response(
        content=body,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        },
    )
