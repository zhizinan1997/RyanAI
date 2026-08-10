"""add per-user bot gateway configuration and binding audit history"""

import sqlalchemy as sa
from alembic import op
from open_webui.migrations.util import get_existing_tables

revision = 'd5e6f7a8b9c0'
down_revision = 'c4d5e6f7a8b9'
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {column['name'] for column in inspector.get_columns(table)} if table in get_existing_tables() else set()


def upgrade() -> None:
    tables = set(get_existing_tables())
    if 'bot_gateway_connection' in tables and 'owner_user_id' not in _columns('bot_gateway_connection'):
        op.add_column('bot_gateway_connection', sa.Column('owner_user_id', sa.String(), nullable=True))
        op.create_foreign_key(
            'fk_bot_gateway_connection_owner_user', 'bot_gateway_connection', 'user',
            ['owner_user_id'], ['id'], ondelete='CASCADE'
        )

    if 'bot_gateway_user_setting' not in tables:
        op.create_table(
            'bot_gateway_user_setting',
            sa.Column('user_id', sa.String(), nullable=False),
            sa.Column('default_model_id', sa.Text(), nullable=True),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('user_id'),
        )
    if 'bot_gateway_binding_history' not in tables:
        op.create_table(
            'bot_gateway_binding_history',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('user_id', sa.String(), nullable=True),
            sa.Column('connection_id', sa.String(), nullable=True),
            sa.Column('channel', sa.String(), nullable=False),
            sa.Column('external_user_id', sa.Text(), nullable=True),
            sa.Column('display_name', sa.Text(), nullable=True),
            sa.Column('action', sa.String(), nullable=False),
            sa.Column('actor_user_id', sa.String(), nullable=True),
            sa.Column('metadata', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(['connection_id'], ['bot_gateway_connection.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(['actor_user_id'], ['user.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_bot_gateway_binding_history_user_created', 'bot_gateway_binding_history', ['user_id', 'created_at'])
        op.create_index('ix_bot_gateway_binding_history_connection_created', 'bot_gateway_binding_history', ['connection_id', 'created_at'])


def downgrade() -> None:
    tables = set(get_existing_tables())
    if 'bot_gateway_binding_history' in tables:
        op.drop_table('bot_gateway_binding_history')
    if 'bot_gateway_user_setting' in tables:
        op.drop_table('bot_gateway_user_setting')
    if 'bot_gateway_connection' in tables and 'owner_user_id' in _columns('bot_gateway_connection'):
        op.drop_constraint('fk_bot_gateway_connection_owner_user', 'bot_gateway_connection', type_='foreignkey')
        op.drop_column('bot_gateway_connection', 'owner_user_id')
