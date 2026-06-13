"""Add email_verification table

Revision ID: f2a3b4c5d6e7
Revises: 461111b60977
Create Date: 2026-06-13 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from open_webui.migrations.util import get_existing_tables

revision: str = 'f2a3b4c5d6e7'
down_revision: Union[str, None] = '461111b60977'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing_tables = set(get_existing_tables())

    if 'email_verification' not in existing_tables:
        op.create_table(
            'email_verification',
            sa.Column('code_hash', sa.String(length=64), nullable=False),
            sa.Column('email', sa.String(length=320), nullable=False),
            sa.Column('expires_at', sa.BigInteger(), nullable=False),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('used_at', sa.BigInteger(), nullable=True),
            sa.PrimaryKeyConstraint('code_hash'),
        )
        op.create_index('idx_email_verification_email', 'email_verification', ['email'])
        op.create_index('idx_email_verification_expires_at', 'email_verification', ['expires_at'])


def downgrade() -> None:
    existing_tables = set(get_existing_tables())

    if 'email_verification' in existing_tables:
        op.drop_index('idx_email_verification_expires_at', table_name='email_verification')
        op.drop_index('idx_email_verification_email', table_name='email_verification')
        op.drop_table('email_verification')
