"""evacuation lift flag on nodes

Revision ID: c5d17e4a0b93
Revises: 8c4e1b7a92d0
Create Date: 2026-10-12 21:30:00.000000

Ordinary lifts are not used during fire or smoke emergencies. A lift marked
as an evacuation lift (a protected lift for evacuating patients) stays
usable. Only nodes of type "lift" may carry the flag. Existing rows get
false, so nothing changes until a lift is marked.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5d17e4a0b93'
down_revision: Union[str, Sequence[str], None] = '8c4e1b7a92d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'nodes',
        sa.Column('is_evacuation_lift', sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_check_constraint(
        'ck_node_evacuation_lift_type', 'nodes',
        "is_evacuation_lift = false OR type = 'lift'",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_node_evacuation_lift_type', 'nodes', type_='check')
    op.drop_column('nodes', 'is_evacuation_lift')
