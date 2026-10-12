"""tenant-safe foreign keys, scenario hazards, undirected edges, soft-delete aware uniques

Revision ID: 8c4e1b7a92d0
Revises: 3f2a9c71d4b8
Create Date: 2026-10-12 21:00:00.000000

What this migration does
- Child rows reference parents with (organization_id, parent_id), so the
  database rejects links between organizations.
- hazards.scenario_id: every hazard belongs to a scenario.
- Edges are undirected: A-B and B-A are the same edge; no self-loops.
- Name/code uniqueness ignores soft-deleted rows (partial unique indexes).
- patients: patient_code unique per organization.

Before changing anything, upgrade() checks existing data and stops with a
readable message (counts only, no personal data) if something conflicts.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8c4e1b7a92d0'
down_revision: Union[str, Sequence[str], None] = '3f2a9c71d4b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Parents that become referenceable by (organization_id, id).
PARENTS = ("hospitals", "buildings", "floors", "nodes", "scenarios", "users")

# (child table, child column, parent table, old FK name, new FK name, ondelete)
TENANT_FKS = (
    ("buildings", "hospital_id", "hospitals", "buildings_hospital_id_fkey", "fk_buildings_hospital", "RESTRICT"),
    ("floors", "building_id", "buildings", "floors_building_id_fkey", "fk_floors_building", "RESTRICT"),
    ("nodes", "floor_id", "floors", "nodes_floor_id_fkey", "fk_nodes_floor", "RESTRICT"),
    ("edges", "from_node_id", "nodes", "edges_from_node_id_fkey", "fk_edges_from_node", "RESTRICT"),
    ("edges", "to_node_id", "nodes", "edges_to_node_id_fkey", "fk_edges_to_node", "RESTRICT"),
    ("patients", "node_id", "nodes", "patients_node_id_fkey", "fk_patients_node", "RESTRICT"),
    ("staff", "node_id", "nodes", "staff_node_id_fkey", "fk_staff_node", "RESTRICT"),
    ("hazards", "origin_node_id", "nodes", "hazards_origin_node_id_fkey", "fk_hazards_origin_node", "RESTRICT"),
    ("simulation_runs", "scenario_id", "scenarios", "simulation_runs_scenario_id_fkey", "fk_simulation_runs_scenario", "RESTRICT"),
    ("evacuation_plans", "scenario_id", "scenarios", "evacuation_plans_scenario_id_fkey", "fk_evacuation_plans_scenario", "RESTRICT"),
    ("scenarios", "created_by_user_id", "users", "scenarios_created_by_user_id_fkey", "fk_scenarios_created_by", "RESTRICT"),
    ("refresh_tokens", "user_id", "users", "refresh_tokens_user_id_fkey", "fk_refresh_tokens_user", "CASCADE"),
)

# Unique constraints that become "unique among non-deleted rows".
# (table, name, columns)
SOFT_DELETE_UNIQUES = (
    ("hospitals", "uq_hospital_org_name", ("organization_id", "name")),
    ("buildings", "uq_building_hospital_name", ("hospital_id", "name")),
    ("floors", "uq_floor_building_number", ("building_id", "floor_number")),
    ("nodes", "uq_node_floor_name", ("floor_id", "name")),
    ("scenarios", "uq_scenario_org_name", ("organization_id", "name")),
    ("staff", "uq_staff_org_code", ("organization_id", "staff_code")),
    ("parameters", "uq_parameter_org_name", ("organization_id", "name")),
    ("evacuation_plans", "uq_evacuation_plan_org_name", ("organization_id", "name")),
)

ACTIVE = sa.text("deleted_at IS NULL")


def _count(sql: str) -> int:
    return op.get_bind().execute(sa.text(sql)).scalar_one()


def _problems_before_upgrade() -> list[str]:
    problems = []
    for child, column, parent, *_ in TENANT_FKS:
        mismatched = _count(
            f"SELECT count(*) FROM {child} c JOIN {parent} p ON p.id = c.{column} "
            f"WHERE p.organization_id <> c.organization_id"
        )
        if mismatched:
            problems.append(
                f"{mismatched} row(s) in {child}.{column} point to a {parent} row "
                "of a different organization"
            )

    hazards = _count("SELECT count(*) FROM hazards")
    if hazards:
        problems.append(
            f"{hazards} hazard(s) exist without a scenario; hazards now belong "
            "to scenarios. Delete or recreate them inside a scenario first"
        )

    self_loops = _count("SELECT count(*) FROM edges WHERE from_node_id = to_node_id")
    if self_loops:
        problems.append(f"{self_loops} edge(s) connect a node to itself")

    reverse_pairs = _count(
        "SELECT count(*) FROM (SELECT 1 FROM edges WHERE deleted_at IS NULL "
        "GROUP BY least(from_node_id, to_node_id), greatest(from_node_id, to_node_id) "
        "HAVING count(*) > 1) d"
    )
    if reverse_pairs:
        problems.append(
            f"{reverse_pairs} pair(s) of nodes are joined by more than one active "
            "edge (A-B and B-A). Soft-delete the extra edges first"
        )

    duplicate_codes = _count(
        "SELECT count(*) FROM (SELECT 1 FROM patients WHERE deleted_at IS NULL "
        "GROUP BY organization_id, patient_code HAVING count(*) > 1) d"
    )
    if duplicate_codes:
        problems.append(
            f"{duplicate_codes} patient code(s) are used more than once in an organization"
        )
    return problems


def upgrade() -> None:
    """Upgrade schema."""
    problems = _problems_before_upgrade()
    if problems:
        raise RuntimeError(
            "Migration stopped, nothing was changed. Fix these first:\n- "
            + "\n- ".join(problems)
        )

    for table in PARENTS:
        op.create_unique_constraint(f"uq_{table}_org_id", table, ["organization_id", "id"])

    for child, column, parent, old_name, new_name, ondelete in TENANT_FKS:
        op.drop_constraint(old_name, child, type_="foreignkey")
        op.create_foreign_key(
            new_name, child, parent,
            ["organization_id", column], ["organization_id", "id"],
            ondelete=ondelete,
        )

    for table, name, columns in SOFT_DELETE_UNIQUES:
        op.drop_constraint(name, table, type_="unique")
        op.create_index(name, table, list(columns), unique=True, postgresql_where=ACTIVE)

    op.drop_constraint("uq_edge_direction", "edges", type_="unique")
    op.create_index(
        "uq_edge_node_pair", "edges",
        [sa.text("least(from_node_id, to_node_id)"), sa.text("greatest(from_node_id, to_node_id)")],
        unique=True, postgresql_where=ACTIVE,
    )
    op.create_check_constraint("ck_edge_distinct_nodes", "edges", "from_node_id <> to_node_id")

    op.create_index(
        "uq_patient_org_code", "patients", ["organization_id", "patient_code"],
        unique=True, postgresql_where=ACTIVE,
    )

    op.add_column("hazards", sa.Column("scenario_id", sa.Integer(), nullable=False))
    op.create_foreign_key(
        "fk_hazards_scenario", "hazards", "scenarios",
        ["organization_id", "scenario_id"], ["organization_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_hazard_org_scenario", "hazards", ["organization_id", "scenario_id"])


def downgrade() -> None:
    """Downgrade schema."""
    # The old full-table unique constraints also count soft-deleted rows, so
    # stop if restoring them would fail.
    problems = []
    for table, name, columns in SOFT_DELETE_UNIQUES:
        cols = ", ".join(columns)
        duplicates = _count(
            f"SELECT count(*) FROM (SELECT 1 FROM {table} GROUP BY {cols} "
            f"HAVING count(*) > 1) d"
        )
        if duplicates:
            problems.append(f"{table}: {duplicates} duplicate value(s) for ({cols}) including deleted rows")
    directed = _count(
        "SELECT count(*) FROM (SELECT 1 FROM edges GROUP BY from_node_id, to_node_id "
        "HAVING count(*) > 1) d"
    )
    if directed:
        problems.append(f"edges: {directed} duplicate (from_node_id, to_node_id) pair(s)")
    if problems:
        raise RuntimeError("Downgrade stopped, nothing was changed:\n- " + "\n- ".join(problems))

    op.drop_index("ix_hazard_org_scenario", table_name="hazards")
    op.drop_constraint("fk_hazards_scenario", "hazards", type_="foreignkey")
    op.drop_column("hazards", "scenario_id")

    op.drop_index("uq_patient_org_code", table_name="patients")

    op.drop_constraint("ck_edge_distinct_nodes", "edges", type_="check")
    op.drop_index("uq_edge_node_pair", table_name="edges")
    op.create_unique_constraint("uq_edge_direction", "edges", ["from_node_id", "to_node_id"])

    for table, name, columns in reversed(SOFT_DELETE_UNIQUES):
        op.drop_index(name, table_name=table)
        op.create_unique_constraint(name, table, list(columns))

    for child, column, parent, old_name, new_name, ondelete in reversed(TENANT_FKS):
        op.drop_constraint(new_name, child, type_="foreignkey")
        op.create_foreign_key(old_name, child, parent, [column], ["id"], ondelete=ondelete)

    for table in reversed(PARENTS):
        op.drop_constraint(f"uq_{table}_org_id", table, type_="unique")
