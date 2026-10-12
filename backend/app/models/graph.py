import enum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    Float,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TenantMixin, TimestampMixin

ACTIVE = text("deleted_at IS NULL")


class NodeType(str, enum.Enum):
    ROOM = "room"
    WARD = "ward"
    ICU = "icu"
    CORRIDOR = "corridor"
    STAIR = "stair"
    RAMP = "ramp"
    LIFT = "lift"
    EXIT = "exit"
    ASSEMBLY = "assembly"


# Node types allowed at both ends of an edge that connects two floors.
VERTICAL_NODE_TYPES = frozenset({NodeType.STAIR, NodeType.RAMP, NodeType.LIFT})


class Node(TenantMixin, TimestampMixin, Base):
    __tablename__ = "nodes"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_nodes_org_id"),
        ForeignKeyConstraint(
            ["organization_id", "floor_id"],
            ["floors.organization_id", "floors.id"],
            name="fk_nodes_floor", ondelete="RESTRICT",
        ),
        Index(
            "uq_node_floor_name", "floor_id", "name",
            unique=True, postgresql_where=ACTIVE,
        ),
        CheckConstraint("capacity >= 0", name="ck_node_capacity_nonnegative"),
        CheckConstraint(
            "is_evacuation_lift = false OR type = 'lift'",
            name="ck_node_evacuation_lift_type",
        ),
        Index("ix_node_org_floor", "organization_id", "floor_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    floor_id: Mapped[int] = mapped_column(nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    type: Mapped[NodeType] = mapped_column(
        Enum(NodeType, name="node_type", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # A protected lift that may still be used during a fire or smoke
    # emergency. Ordinary lifts are not used in those scenarios.
    is_evacuation_lift: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )


class Edge(TenantMixin, TimestampMixin, Base):
    """An undirected connection between two nodes (A-B is the same as B-A)."""

    __tablename__ = "edges"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id", "from_node_id"],
            ["nodes.organization_id", "nodes.id"],
            name="fk_edges_from_node", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["organization_id", "to_node_id"],
            ["nodes.organization_id", "nodes.id"],
            name="fk_edges_to_node", ondelete="RESTRICT",
        ),
        CheckConstraint("distance >= 0", name="ck_edge_distance_nonnegative"),
        CheckConstraint("width > 0", name="ck_edge_width_positive"),
        CheckConstraint("max_flow > 0", name="ck_edge_max_flow_positive"),
        CheckConstraint("from_node_id <> to_node_id", name="ck_edge_distinct_nodes"),
        Index(
            "uq_edge_node_pair",
            func.least(text("from_node_id"), text("to_node_id")),
            func.greatest(text("from_node_id"), text("to_node_id")),
            unique=True, postgresql_where=ACTIVE,
        ),
        Index("ix_edge_org_from", "organization_id", "from_node_id"),
        Index("ix_edge_org_to", "organization_id", "to_node_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    from_node_id: Mapped[int] = mapped_column(nullable=False)
    to_node_id: Mapped[int] = mapped_column(nullable=False)
    distance: Mapped[float] = mapped_column(Float, nullable=False)
    width: Mapped[float] = mapped_column(Float, nullable=False)
    max_flow: Mapped[int] = mapped_column(Integer, nullable=False)
    wheelchair_accessible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    stretcher_accessible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    is_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
