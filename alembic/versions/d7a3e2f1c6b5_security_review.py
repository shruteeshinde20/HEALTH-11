"""security and quality review (build step 15)

Revision ID: d7a3e2f1c6b5
Revises: c5d17e4a0b93
Create Date: 2026-10-13 16:30:00.000000

- users.tokens_valid_after: tokens issued before it are refused, so a
  password change or reset ends every other session at once (not only when
  their access tokens expire).
- refresh_tokens.revoked_reason: a refresh token replaced by a newer one
  ("rotated") that comes back later means it was copied; then every session
  of that user ends. Tokens ended by logout or a password change do not.
- updated_at is kept current by the database itself (a trigger), also for
  bulk UPDATE statements that bypass the ORM.
- Defaults that only existed in Python now also exist in the database, so
  rows written by other tools get the same values.
- Hospitals default to the UTC time zone (no country-specific default).
- The audit log index for "what happened to this item" starts with the
  organization, like every other tenant query.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7a3e2f1c6b5'
down_revision: Union[str, Sequence[str], None] = 'c5d17e4a0b93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES_WITH_UPDATED_AT = [
    "audit_log", "buildings", "edges", "evacuation_plans", "floors", "hazards", "hospitals",
    "ml_models", "nodes", "organizations", "parameters", "patients", "rate_limit_events",
    "refresh_tokens", "scenarios", "simulation_runs", "staff", "users",
]

# (table, column, new server default, old server default)
DEFAULTS = [
    ("hospitals", "timezone", sa.text("'UTC'"), None),
    ("nodes", "x", sa.text("0"), None),
    ("nodes", "y", sa.text("0"), None),
    ("nodes", "capacity", sa.text("0"), None),
    ("nodes", "is_blocked", sa.false(), None),
    ("edges", "wheelchair_accessible", sa.true(), None),
    ("edges", "stretcher_accessible", sa.true(), None),
    ("edges", "is_blocked", sa.false(), None),
    ("patients", "criticality", sa.text("3"), None),
    ("patients", "is_synthetic", sa.false(), None),
    ("staff", "is_synthetic", sa.false(), None),
    ("hazards", "spread_rate", sa.text("0"), None),
    ("hazards", "severity", sa.text("1"), None),
    ("hazards", "is_active", sa.true(), None),
    ("scenarios", "is_active", sa.true(), None),
    ("users", "is_active", sa.true(), None),
]


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('tokens_valid_after', sa.DateTime(timezone=True), nullable=True))
    op.add_column('refresh_tokens', sa.Column('revoked_reason', sa.String(length=30), nullable=True))

    op.drop_index('ix_audit_log_entity', table_name='audit_log')
    op.create_index('ix_audit_log_org_entity', 'audit_log', ['organization_id', 'entity_type', 'entity_id'])

    for table, column, default, _old in DEFAULTS:
        op.alter_column(table, column, server_default=default)

    op.execute("""
        CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
        BEGIN
            -- clock_timestamp(): the real time of the change, also inside long transactions.
            NEW.updated_at = clock_timestamp();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    for table in TABLES_WITH_UPDATED_AT:
        op.execute(
            f"CREATE TRIGGER trg_{table}_updated_at BEFORE UPDATE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
        )


def downgrade() -> None:
    """Downgrade schema."""
    for table in TABLES_WITH_UPDATED_AT:
        op.execute(f"DROP TRIGGER trg_{table}_updated_at ON {table}")
    op.execute("DROP FUNCTION set_updated_at()")

    for table, column, _default, old in reversed(DEFAULTS):
        op.alter_column(table, column, server_default=old)

    op.drop_index('ix_audit_log_org_entity', table_name='audit_log')
    op.create_index('ix_audit_log_entity', 'audit_log', ['entity_type', 'entity_id'])

    op.drop_column('refresh_tokens', 'revoked_reason')
    op.drop_column('users', 'tokens_valid_after')
