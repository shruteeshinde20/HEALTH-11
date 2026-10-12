"""unique user email per organization and rate limit events

Revision ID: 3f2a9c71d4b8
Revises: ee966485c69f
Create Date: 2026-10-12 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3f2a9c71d4b8'
down_revision: Union[str, Sequence[str], None] = 'ee966485c69f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    connection = op.get_bind()

    # Refuse to continue (instead of failing with a raw database error) if
    # existing data already breaks the new rule. Only a count is reported so
    # no email addresses are printed.
    duplicate_groups = connection.execute(sa.text(
        """
        SELECT count(*) FROM (
            SELECT 1 FROM users
            WHERE deleted_at IS NULL
            GROUP BY organization_id, lower(email)
            HAVING count(*) > 1
        ) AS duplicates
        """
    )).scalar_one()
    if duplicate_groups:
        raise RuntimeError(
            f"{duplicate_groups} email address(es) are used by more than one "
            "active user in the same organization. Resolve them (rename or "
            "soft-delete the extra users) and run the migration again."
        )

    # Store emails in lowercase so login and the unique index agree.
    op.execute("UPDATE users SET email = lower(email) WHERE email <> lower(email)")

    op.create_index(
        'uq_users_org_email_active',
        'users',
        ['organization_id', sa.text('lower(email)')],
        unique=True,
        postgresql_where=sa.text('deleted_at IS NULL'),
    )

    op.create_table('rate_limit_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('bucket_key', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_rate_limit_events_key_created', 'rate_limit_events', ['bucket_key', 'created_at'], unique=False)
    op.create_index('ix_rate_limit_events_created', 'rate_limit_events', ['created_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_rate_limit_events_created', table_name='rate_limit_events')
    op.drop_index('ix_rate_limit_events_key_created', table_name='rate_limit_events')
    op.drop_table('rate_limit_events')
    op.drop_index('uq_users_org_email_active', table_name='users')
