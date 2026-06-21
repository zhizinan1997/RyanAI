"""add notification table

Revision ID: c3d4e5f6a7b8
Revises: b1c2d3e4f5a6
Create Date: 2026-06-21 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())

    if 'notification' not in existing_tables:
        op.create_table(
            'notification',
            sa.Column('id', sa.Text(), nullable=False),
            sa.Column('type', sa.Text(), nullable=False),
            sa.Column('title', sa.Text(), nullable=True),
            sa.Column('content', sa.Text(), nullable=False),
            sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('dismissible', sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.Column('published_at', sa.BigInteger(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('notification_active_idx', 'notification', ['active'])
        op.create_index('notification_published_at_idx', 'notification', ['published_at'])


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())

    if 'notification' in existing_tables:
        op.drop_index('notification_published_at_idx', table_name='notification')
        op.drop_index('notification_active_idx', table_name='notification')
        op.drop_table('notification')
