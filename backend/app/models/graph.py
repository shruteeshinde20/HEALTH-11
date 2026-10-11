import enum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, TenantMixin, TimestampMixin


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


class Node(TenantMixin, TimestampMixin, Base):
    __tablename__ = "nodes"
    __table_args__ = (
        UniqueConstraint("floor_id", "name", name="uq_node_floor_name"),
        CheckConstraint("capacity >= 0", name="ck_node_capacity_nonnegative"),
        Index("ix_node_org_floor", "organization_id", "floor_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    floor_id: Mapped[int] = mapped_column(
        ForeignKey("floors.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    type: Mapped[NodeType] = mapped_column(
        Enum(NodeType, name="node_type", values_callable=lambda enum_cls: [member.value for member in enum_cls]), nullable=False
    )
    x: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    y: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Edge(TenantMixin, TimestampMixin, Base):
    __tablename__ = "edges"
    __table_args__ = (
        CheckConstraint("distance >= 0", name="ck_edge_distance_nonnegative"),
        CheckConstraint("width > 0", name="ck_edge_width_positive"),
        CheckConstraint("max_flow > 0", name="ck_edge_max_flow_positive"),
        UniqueConstraint("from_node_id", "to_node_id", name="uq_edge_direction"),
        Index("ix_edge_org_from", "organization_id", "from_node_id"),
        Index("ix_edge_org_to", "organization_id", "to_node_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    from_node_id: Mapped[int] = mapped_column(
        ForeignKey("nodes.id", ondelete="RESTRICT"), nullable=False
    )
    to_node_id: Mapped[int] = mapped_column(
        ForeignKey("nodes.id", ondelete="RESTRICT"), nullable=False
    )
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
