"""password reset codes ("Forgot password?" by e-mail)

Revision ID: f4c9d1e7b2a3
Revises: e3b8c2d4f6a1
Create Date: 2026-10-21 02:00:00.000000

One row per code sent by e-mail. Only a keyed hash of the code is stored.
Rows belong to a user of the same organization and go when the user goes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f4c9d1e7b2a3'
down_revision: Union[str, Sequence[str], None] = 'e3b8c2d4f6a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'password_reset_codes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('organization_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint('attempts >= 0', name='ck_password_reset_codes_attempts'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['organization_id', 'user_id'], ['users.organization_id', 'users.id'],
                                name='fk_password_reset_codes_user', ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_password_reset_codes_org_user', 'password_reset_codes',
                    ['organization_id', 'user_id'], unique=False)
    op.create_index(op.f('ix_password_reset_codes_organization_id'), 'password_reset_codes',
                    ['organization_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_password_reset_codes_organization_id'), table_name='password_reset_codes')
    op.drop_index('ix_password_reset_codes_org_user', table_name='password_reset_codes')
    op.drop_table('password_reset_codes')
