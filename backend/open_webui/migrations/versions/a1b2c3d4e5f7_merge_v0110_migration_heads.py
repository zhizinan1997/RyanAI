"""merge v0.11.0 migration heads

Revision ID: a1b2c3d4e5f7
Revises: 8d3f2c9a1b7e, f0bd01a18a3d
Create Date: 2026-07-31 00:00:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f7'
down_revision: str | Sequence[str] | None = ('8d3f2c9a1b7e', 'f0bd01a18a3d')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
