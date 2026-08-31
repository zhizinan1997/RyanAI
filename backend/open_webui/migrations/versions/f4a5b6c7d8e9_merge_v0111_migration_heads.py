"""merge RyanAI and upstream v0.11.1 migration heads

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8, d4c1a8e37b62
Create Date: 2026-08-28 00:00:00.000000

"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f4a5b6c7d8e9'
down_revision: str | Sequence[str] | None = ('e3f4a5b6c7d8', 'd4c1a8e37b62')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Complete the upstream branch when the RyanAI head already contains it.

    The RyanAI migration head (e3f4...) and the upstream v0.11.1 head
    (d4c1...) are sibling branches. A database stamped at e3f4... reaches
    this merge revision without running d4c1..., so the merge must repair the
    schema instead of being a no-op.
    """
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())

    if 'chat' in tables:
        columns = {column['name'] for column in inspector.get_columns('chat')}
        if 'timer_at' not in columns:
            op.add_column('chat', sa.Column('timer_at', sa.BigInteger(), nullable=True))

        inspector.clear_cache()
        indexes = {index['name'] for index in inspector.get_indexes('chat')}
        if 'timer_at_idx' not in indexes:
            op.create_index(
                'timer_at_idx',
                'chat',
                ['timer_at'],
                sqlite_where=sa.text('timer_at IS NOT NULL'),
                postgresql_where=sa.text('timer_at IS NOT NULL'),
            )
        if 'user_id_updated_at_id_idx' not in indexes:
            op.create_index('user_id_updated_at_id_idx', 'chat', ['user_id', sa.text('updated_at DESC'), 'id'])
        if 'user_id_timer_at_idx' not in indexes:
            op.create_index(
                'user_id_timer_at_idx',
                'chat',
                ['user_id', 'timer_at'],
                sqlite_where=sa.text('timer_at IS NOT NULL'),
                postgresql_where=sa.text('timer_at IS NOT NULL'),
            )
        if 'user_id_folder_unread_idx' not in indexes:
            op.create_index(
                'user_id_folder_unread_idx',
                'chat',
                ['user_id', 'folder_id', 'archived', 'updated_at', 'last_read_at', 'id'],
            )

        inspector.clear_cache()
        chat_columns = {column['name'] for column in inspector.get_columns('chat')}
        if 'meta' in chat_columns and 'timer_at' in chat_columns:
            chat = sa.table(
                'chat',
                sa.column('id', sa.String),
                sa.column('meta', sa.JSON),
                sa.column('timer_at', sa.BigInteger),
            )
            rows = conn.execute(sa.select(chat.c.id, chat.c.meta).where(chat.c.meta.is_not(None))).fetchall()
            for chat_id, meta in rows:
                if isinstance(meta, str):
                    try:
                        meta = json.loads(meta)
                    except (TypeError, ValueError):
                        continue
                if not isinstance(meta, dict):
                    continue
                if meta.get('type') != 'timer' or meta.get('status') != 'pending':
                    continue
                try:
                    due_at = int(meta.get('timer_at'))
                except (TypeError, ValueError):
                    continue
                conn.execute(chat.update().where(chat.c.id == chat_id).values(timer_at=due_at))

    if 'chat_message' in tables:
        indexes = {index['name'] for index in inspector.get_indexes('chat_message')}
        if 'chat_message_chat_role_done_idx' not in indexes:
            op.create_index('chat_message_chat_role_done_idx', 'chat_message', ['chat_id', 'role', 'done'])

    if 'group_member' in tables:
        indexes = {index['name'] for index in inspector.get_indexes('group_member')}
        if 'ix_group_member_user_id_group_id' not in indexes:
            op.create_index('ix_group_member_user_id_group_id', 'group_member', ['user_id', 'group_id'])

    if 'user' in tables:
        user_columns = {column['name'] for column in inspector.get_columns('user')}
        if 'oauth' in user_columns:
            user = sa.table('user', sa.column('id', sa.Text), sa.column('oauth', sa.JSON))
            rows = conn.execute(sa.select(user.c.id, user.c.oauth).where(user.c.oauth.is_not(None))).fetchall()
            for user_id, oauth in rows:
                if not isinstance(oauth, str):
                    continue
                try:
                    decoded = json.loads(oauth)
                except (TypeError, ValueError):
                    continue
                if isinstance(decoded, dict):
                    conn.execute(user.update().where(user.c.id == user_id).values(oauth=decoded))


def downgrade() -> None:
    pass
