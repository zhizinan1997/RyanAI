"""add bot gateway tables

Revision ID: b2c3d4e5f6a8
Revises: a1b2c3d4e5f7
Create Date: 2026-08-09 00:00:00.000000

"""

import time
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from open_webui.migrations.util import get_existing_tables

revision: str = 'b2c3d4e5f6a8'
down_revision: str | None = 'a1b2c3d4e5f7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    existing_tables = set(get_existing_tables())

    if 'bot_gateway_connection' not in existing_tables:
        op.create_table(
            'bot_gateway_connection',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('channel', sa.String(), nullable=False),
            sa.Column('name', sa.Text(), nullable=False),
            sa.Column('enabled', sa.Boolean(), nullable=False),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('credentials_configured', sa.Boolean(), nullable=False),
            sa.Column('account_id', sa.Text(), nullable=True),
            sa.Column('account_name', sa.Text(), nullable=True),
            sa.Column('config', sa.JSON(), nullable=True),
            sa.Column('last_error', sa.Text(), nullable=True),
            sa.Column('last_seen_at', sa.BigInteger(), nullable=True),
            sa.Column('created_by', sa.String(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(['created_by'], ['user.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index(
            'ix_bot_gateway_connection_channel_enabled',
            'bot_gateway_connection',
            ['channel', 'enabled'],
        )
        op.create_index('ix_bot_gateway_connection_status', 'bot_gateway_connection', ['status'])

    if 'bot_gateway_binding' not in existing_tables:
        op.create_table(
            'bot_gateway_binding',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('user_id', sa.String(), nullable=False),
            sa.Column('external_user_id', sa.Text(), nullable=False),
            sa.Column('display_name', sa.Text(), nullable=True),
            sa.Column('enabled', sa.Boolean(), nullable=False),
            sa.Column('blocked', sa.Boolean(), nullable=False),
            sa.Column('blocked_at', sa.BigInteger(), nullable=True),
            sa.Column('blocked_by', sa.String(), nullable=True),
            sa.Column('unbind_requested_at', sa.BigInteger(), nullable=True),
            sa.Column('last_seen_at', sa.BigInteger(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(
                ['connection_id'],
                ['bot_gateway_connection.id'],
                ondelete='CASCADE',
            ),
            sa.ForeignKeyConstraint(['blocked_by'], ['user.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint(
                'connection_id',
                'external_user_id',
                name='uq_bot_gateway_binding_connection_identity',
            ),
        )
        op.create_index(
            'ix_bot_gateway_binding_user_enabled',
            'bot_gateway_binding',
            ['user_id', 'enabled'],
        )
        op.create_index(
            'ix_bot_gateway_binding_connection_enabled',
            'bot_gateway_binding',
            ['connection_id', 'enabled'],
        )

    if 'bot_gateway_conversation' not in existing_tables:
        op.create_table(
            'bot_gateway_conversation',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('binding_id', sa.String(), nullable=False),
            sa.Column('user_id', sa.String(), nullable=False),
            sa.Column('conversation_type', sa.String(), nullable=False),
            sa.Column('external_conversation_id', sa.Text(), nullable=False),
            sa.Column('external_sender_id', sa.Text(), nullable=False),
            sa.Column('session_key', sa.Text(), nullable=False),
            sa.Column('chat_id', sa.String(), nullable=True),
            sa.Column('model_id', sa.Text(), nullable=True),
            sa.Column('last_event_at', sa.BigInteger(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(
                ['binding_id'],
                ['bot_gateway_binding.id'],
                ondelete='CASCADE',
            ),
            sa.ForeignKeyConstraint(['chat_id'], ['chat.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(
                ['connection_id'],
                ['bot_gateway_connection.id'],
                ondelete='CASCADE',
            ),
            sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint(
                'binding_id',
                'session_key',
                name='uq_bot_gateway_conversation_binding_session',
            ),
        )
        op.create_index(
            'ix_bot_gateway_conversation_chat',
            'bot_gateway_conversation',
            ['chat_id'],
        )
        op.create_index(
            'ix_bot_gateway_conversation_connection_scope',
            'bot_gateway_conversation',
            ['connection_id', 'conversation_type'],
        )

    if 'bot_gateway_binding_code' not in existing_tables:
        op.create_table(
            'bot_gateway_binding_code',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('user_id', sa.String(), nullable=False),
            sa.Column('channel', sa.String(), nullable=True),
            sa.Column('code_hash', sa.String(length=64), nullable=False),
            sa.Column('expires_at', sa.BigInteger(), nullable=False),
            sa.Column('consumed_at', sa.BigInteger(), nullable=True),
            sa.Column('consumed_by_binding_id', sa.String(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(
                ['consumed_by_binding_id'],
                ['bot_gateway_binding.id'],
                ondelete='SET NULL',
            ),
            sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('code_hash'),
        )
        op.create_index(
            'ix_bot_gateway_binding_code_user_expires',
            'bot_gateway_binding_code',
            ['user_id', 'expires_at'],
        )
        op.create_index(
            'ix_bot_gateway_binding_code_channel_expires',
            'bot_gateway_binding_code',
            ['channel', 'expires_at'],
        )

    if 'bot_gateway_group' not in existing_tables:
        op.create_table(
            'bot_gateway_group',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('external_group_id', sa.Text(), nullable=False),
            sa.Column('name', sa.Text(), nullable=True),
            sa.Column('allowed', sa.Boolean(), nullable=False),
            sa.Column('member_count', sa.Integer(), nullable=True),
            sa.Column('discovered_at', sa.BigInteger(), nullable=True),
            sa.Column('last_seen_at', sa.BigInteger(), nullable=True),
            sa.Column('updated_by', sa.String(), nullable=True),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(
                ['connection_id'],
                ['bot_gateway_connection.id'],
                ondelete='CASCADE',
            ),
            sa.ForeignKeyConstraint(['updated_by'], ['user.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint(
                'connection_id',
                'external_group_id',
                name='uq_bot_gateway_group_connection_group',
            ),
        )
        op.create_index(
            'ix_bot_gateway_group_connection_allowed',
            'bot_gateway_group',
            ['connection_id', 'allowed'],
        )
        op.create_index(
            'ix_bot_gateway_group_connection_seen',
            'bot_gateway_group',
            ['connection_id', 'last_seen_at'],
        )

    if 'bot_gateway_request_nonce' not in existing_tables:
        op.create_table(
            'bot_gateway_request_nonce',
            sa.Column('nonce', sa.String(length=128), nullable=False),
            sa.Column('expires_at', sa.BigInteger(), nullable=False),
            sa.Column('created_at', sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint('nonce'),
        )
        op.create_index(
            'ix_bot_gateway_request_nonce_expires',
            'bot_gateway_request_nonce',
            ['expires_at'],
        )

    if 'bot_gateway_event' not in existing_tables:
        op.create_table(
            'bot_gateway_event',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('connection_id', sa.String(), nullable=False),
            sa.Column('event_id', sa.Text(), nullable=False),
            sa.Column('request_hash', sa.String(length=64), nullable=False),
            sa.Column('request_nonce', sa.String(length=128), nullable=False),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('conversation_type', sa.String(), nullable=True),
            sa.Column('external_conversation_id', sa.Text(), nullable=True),
            sa.Column('external_sender_id', sa.Text(), nullable=True),
            sa.Column('binding_id', sa.String(), nullable=True),
            sa.Column('conversation_id', sa.String(), nullable=True),
            sa.Column('chat_id', sa.String(), nullable=True),
            sa.Column('assistant_message_id', sa.String(), nullable=True),
            sa.Column('response', sa.JSON(), nullable=True),
            sa.Column('error', sa.Text(), nullable=True),
            sa.Column('attempts', sa.Integer(), nullable=False),
            sa.Column('received_at', sa.BigInteger(), nullable=False),
            sa.Column('completed_at', sa.BigInteger(), nullable=True),
            sa.Column('updated_at', sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(
                ['binding_id'],
                ['bot_gateway_binding.id'],
                ondelete='SET NULL',
            ),
            sa.ForeignKeyConstraint(['chat_id'], ['chat.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(
                ['connection_id'],
                ['bot_gateway_connection.id'],
                ondelete='CASCADE',
            ),
            sa.ForeignKeyConstraint(
                ['conversation_id'],
                ['bot_gateway_conversation.id'],
                ondelete='SET NULL',
            ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint(
                'connection_id',
                'event_id',
                name='uq_bot_gateway_event_connection_event',
            ),
        )
        op.create_index(
            'ix_bot_gateway_event_status_received',
            'bot_gateway_event',
            ['status', 'received_at'],
        )
        op.create_index(
            'ix_bot_gateway_event_updated',
            'bot_gateway_event',
            ['updated_at'],
        )
        op.create_index(
            'ix_bot_gateway_event_connection_received',
            'bot_gateway_event',
            ['connection_id', 'received_at'],
        )
        op.create_index('ix_bot_gateway_event_nonce', 'bot_gateway_event', ['request_nonce'])

    connection_table = sa.table(
        'bot_gateway_connection',
        sa.column('id', sa.String()),
        sa.column('channel', sa.String()),
        sa.column('name', sa.Text()),
        sa.column('enabled', sa.Boolean()),
        sa.column('status', sa.String()),
        sa.column('credentials_configured', sa.Boolean()),
        sa.column('config', sa.JSON()),
        sa.column('created_at', sa.BigInteger()),
        sa.column('updated_at', sa.BigInteger()),
    )
    bind = op.get_bind()
    now = int(time.time())
    defaults = (
        ('wechat-default', 'wechat', '个人微信机器人'),
        ('qq-default', 'qq', '个人 QQ 机器人'),
    )
    for connection_id, channel, name in defaults:
        exists = bind.execute(sa.select(connection_table.c.id).where(connection_table.c.id == connection_id)).first()
        if exists is None:
            bind.execute(
                connection_table.insert().values(
                    id=connection_id,
                    channel=channel,
                    name=name,
                    enabled=False,
                    status='logged_out',
                    credentials_configured=False,
                    config={},
                    created_at=now,
                    updated_at=now,
                )
            )


def downgrade() -> None:
    existing_tables = set(get_existing_tables())
    for table_name in (
        'bot_gateway_event',
        'bot_gateway_request_nonce',
        'bot_gateway_group',
        'bot_gateway_binding_code',
        'bot_gateway_conversation',
        'bot_gateway_binding',
        'bot_gateway_connection',
    ):
        if table_name in existing_tables:
            op.drop_table(table_name)
