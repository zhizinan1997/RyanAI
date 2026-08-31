"""merge RyanAI and upstream v0.11.1 migration heads

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8, d4c1a8e37b62
Create Date: 2026-08-28 00:00:00.000000

"""

from collections.abc import Sequence


# revision identifiers, used by Alembic.
revision: str = 'f4a5b6c7d8e9'
down_revision: str | Sequence[str] | None = ('e3f4a5b6c7d8', 'd4c1a8e37b62')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
