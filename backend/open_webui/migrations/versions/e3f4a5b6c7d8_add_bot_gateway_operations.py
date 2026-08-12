"""add bot gateway credential center and runtime assignment columns

Revision ID: e3f4a5b6c7d8
Revises: d5e6f7a8b9c0
Create Date: 2026-08-12 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op
from open_webui.migrations.util import get_existing_tables

revision: str = 'e3f4a5b6c7d8'
down_revision: str | None = 'd5e6f7a8b9c0'
branch_labels: str | None = None
depends_on: str | None = None


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {column['name'] for column in inspector.get_columns(table)} if table in get_existing_tables() else set()


def upgrade() -> None:
    tables = set(get_existing_tables())
    if 'bot_gateway_connection' in tables:
        # SQLite rebuilds the table in batch mode; other databases run plain ALTER.
        with op.batch_alter_table('bot_gateway_connection') as batch_op:
            if 'shard_id' not in _columns('bot_gateway_connection'):
                batch_op.add_column(sa.Column('shard_id', sa.String(), nullable=True))
            if 'account_key' not in _columns('bot_gateway_connection'):
                batch_op.add_column(sa.Column('account_key', sa.Text(), nullable=True))
            if 'assignment_generation' not in _columns('bot_gateway_connection'):
                batch_op.add_column(sa.Column('assignment_generation', sa.Integer(), nullable=True))
            if 'last_runtime_node_id' not in _columns('bot_gateway_connection'):
                batch_op.add_column(sa.Column('last_runtime_node_id', sa.String(), nullable=True))
            if 'last_runtime_at' not in _columns('bot_gateway_connection'):
                batch_op.add_column(sa.Column('last_runtime_at', sa.BigInteger(), nullable=True))

    if 'bot_gateway_credential' not in tables:
        op.create_table(
            'bot_gateway_credential',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('channel', sa.String(), nullable=False),
            sa.Column('account_digest', sa.String(length=64), nullable=False),
            sa.Column('envelope', sa.Text(), nullable=False),
            sa.Column('key_version', sa.Integer(), nullable=False),
            sa.Column('schema_version', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(['connection_id'], ['bot_gateway_connection.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('connection_id'),
            sa.UniqueConstraint('account_digest', name='uq_bot_gateway_credential_account_digest'),
        )
        op.create_index('ix_bot_gateway_credential_channel', 'bot_gateway_credential', ['channel'])

    if 'bot_gateway_shard' not in tables:
        op.create_table(
            'bot_gateway_shard',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('channel', sa.String(), nullable=False),
            sa.Column('account_capacity', sa.Integer(), nullable=False),
            sa.Column('load_capacity', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint('id'),
        )

    if 'bot_gateway_node' not in tables:
        op.create_table(
            'bot_gateway_node',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('advertise_url', sa.Text(), nullable=True),
            sa.Column('capabilities', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.Column('last_seen_at', sa.BigInteger(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )

    if 'bot_gateway_account_checkpoint' not in tables:
        op.create_table(
            'bot_gateway_account_checkpoint',
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('payload', sa.Text(), nullable=False),
            sa.Column('payload_sha256', sa.String(length=64), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(['connection_id'], ['bot_gateway_connection.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('connection_id'),
        )

    if 'bot_gateway_control_operation' not in tables:
        op.create_table(
            'bot_gateway_control_operation',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('kind', sa.String(), nullable=False),
            sa.Column('payload', sa.JSON(), nullable=True),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('actor_user_id', sa.String(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.Column('completed_at', sa.BigInteger(), nullable=True),
            sa.ForeignKeyConstraint(['actor_user_id'], ['user.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )


def downgrade() -> None:
    tables = set(get_existing_tables())
    for table_name in (
        'bot_gateway_control_operation',
        'bot_gateway_account_checkpoint',
        'bot_gateway_node',
        'bot_gateway_shard',
        'bot_gateway_credential',
    ):
        if table_name in tables:
            op.drop_table(table_name)
    if 'bot_gateway_connection' in tables:
        # SQLite drops nullable columns via batch table rebuild.
        with op.batch_alter_table('bot_gateway_connection') as batch_op:
            for column in (
                'shard_id',
                'account_key',
                'assignment_generation',
                'last_runtime_node_id',
                'last_runtime_at',
            ):
                if column in _columns('bot_gateway_connection'):
                    batch_op.drop_column(column)
