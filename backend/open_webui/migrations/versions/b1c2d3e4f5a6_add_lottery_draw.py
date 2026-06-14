"""add lottery_draw

Revision ID: b1c2d3e4f5a6
Revises: f2a3b4c5d6e7
Create Date: 2026-06-13 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'f2a3b4c5d6e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'lottery_draw',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('user_id', sa.String(), nullable=False),
        sa.Column('draw_date', sa.String(), nullable=False),
        sa.Column('reward', sa.Numeric(precision=24, scale=12), nullable=True),
        sa.Column('cards', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_lottery_draw_user_id'), 'lottery_draw', ['user_id'], unique=False)
    op.create_index(op.f('ix_lottery_draw_draw_date'), 'lottery_draw', ['draw_date'], unique=False)
    op.create_index(op.f('ix_lottery_draw_created_at'), 'lottery_draw', ['created_at'], unique=False)
    op.create_index('idx_lottery_user_date', 'lottery_draw', ['user_id', 'draw_date'], unique=True)


def downgrade() -> None:
    op.drop_index('idx_lottery_user_date', table_name='lottery_draw')
    op.drop_index(op.f('ix_lottery_draw_created_at'), table_name='lottery_draw')
    op.drop_index(op.f('ix_lottery_draw_draw_date'), table_name='lottery_draw')
    op.drop_index(op.f('ix_lottery_draw_user_id'), table_name='lottery_draw')
    op.drop_table('lottery_draw')
