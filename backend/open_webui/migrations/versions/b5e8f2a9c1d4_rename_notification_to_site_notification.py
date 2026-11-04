"""rename the RyanAI announcement table to site_notification

Revision ID: b5e8f2a9c1d4
Revises: 82b57ad2d0d4
Create Date: 2026-11-04 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b5e8f2a9c1d4'
down_revision: str | Sequence[str] | None = '82b57ad2d0d4'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rename(old: str, new: str) -> None:
    """Rename the announcement table together with its indexes and primary key.

    Upstream v0.13.0 reuses the ``notification`` table name for the per-user
    inbox (e42c8f710a36), so the RyanAI announcement table has to move out of
    the way first. The rename is done index by index because PostgreSQL keeps
    the old index and ``notification_pkey`` names on a renamed table, which
    would collide with the ones the inbox migration creates.
    """
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())
    if old not in tables or new in tables:
        return

    indexes = {index['name'] for index in inspector.get_indexes(old)}
    pk_name = inspector.get_pk_constraint(old).get('name')
    for suffix in ('active_idx', 'published_at_idx'):
        if f'{old}_{suffix}' in indexes:
            op.drop_index(f'{old}_{suffix}', table_name=old)

    op.rename_table(old, new)
    if conn.dialect.name == 'postgresql' and pk_name == f'{old}_pkey':
        op.execute(f'ALTER TABLE {new} RENAME CONSTRAINT {old}_pkey TO {new}_pkey')

    op.create_index(f'{new}_active_idx', new, ['active'])
    op.create_index(f'{new}_published_at_idx', new, ['published_at'])


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table('notification'):
        # A table that already has user_id is the upstream inbox, not the announcement table.
        if 'user_id' in {column['name'] for column in inspector.get_columns('notification')}:
            return
    _rename('notification', 'site_notification')


def downgrade() -> None:
    _rename('site_notification', 'notification')
