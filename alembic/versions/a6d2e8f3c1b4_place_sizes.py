"""place sizes in metres (width and length)

Revision ID: a6d2e8f3c1b4
Revises: f4c9d1e7b2a3
Create Date: 2026-10-21 11:00:00.000000

Optional width and length in metres for each place (node), used to draw the
floor plan. Both or neither; each above 0 and at most 1,000 m. Existing places
keep no size until one is entered; routes and simulations do not use it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a6d2e8f3c1b4'
down_revision: Union[str, Sequence[str], None] = 'f4c9d1e7b2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('nodes', sa.Column('width_m', sa.Float(), nullable=True))
    op.add_column('nodes', sa.Column('length_m', sa.Float(), nullable=True))
    op.create_check_constraint(
        'ck_node_width_range', 'nodes',
        "width_m IS NULL OR (width_m > 0 AND width_m <= 1000)",
    )
    op.create_check_constraint(
        'ck_node_length_range', 'nodes',
        "length_m IS NULL OR (length_m > 0 AND length_m <= 1000)",
    )
    op.create_check_constraint(
        'ck_node_size_pair', 'nodes',
        "(width_m IS NULL) = (length_m IS NULL)",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_node_size_pair', 'nodes', type_='check')
    op.drop_constraint('ck_node_length_range', 'nodes', type_='check')
    op.drop_constraint('ck_node_width_range', 'nodes', type_='check')
    op.drop_column('nodes', 'length_m')
    op.drop_column('nodes', 'width_m')
