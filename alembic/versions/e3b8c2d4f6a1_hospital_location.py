"""hospital map position (latitude and longitude)

Revision ID: e3b8c2d4f6a1
Revises: d7a3e2f1c6b5
Create Date: 2026-10-21 01:20:00.000000

Optional decimal degrees (WGS 84) for each hospital, needed by the outside
data sources (OpenStreetMap, weather, official alerts). The database refuses
values out of range and a latitude without a longitude (or the reverse).
Existing hospitals keep no position until one is entered.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3b8c2d4f6a1'
down_revision: Union[str, Sequence[str], None] = 'd7a3e2f1c6b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('hospitals', sa.Column('latitude', sa.Float(), nullable=True))
    op.add_column('hospitals', sa.Column('longitude', sa.Float(), nullable=True))
    op.create_check_constraint(
        'ck_hospital_latitude_range', 'hospitals',
        "latitude IS NULL OR (latitude >= -90 AND latitude <= 90)",
    )
    op.create_check_constraint(
        'ck_hospital_longitude_range', 'hospitals',
        "longitude IS NULL OR (longitude >= -180 AND longitude <= 180)",
    )
    op.create_check_constraint(
        'ck_hospital_location_pair', 'hospitals',
        "(latitude IS NULL) = (longitude IS NULL)",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_hospital_location_pair', 'hospitals', type_='check')
    op.drop_constraint('ck_hospital_longitude_range', 'hospitals', type_='check')
    op.drop_constraint('ck_hospital_latitude_range', 'hospitals', type_='check')
    op.drop_column('hospitals', 'longitude')
    op.drop_column('hospitals', 'latitude')
