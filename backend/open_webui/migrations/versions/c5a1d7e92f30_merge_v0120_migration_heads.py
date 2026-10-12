"""merge RyanAI and upstream v0.12.0 migration heads

Revision ID: c5a1d7e92f30
Revises: b8f2c6d91a04, f4a5b6c7d8e9
Create Date: 2026-10-12 00:00:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = 'c5a1d7e92f30'
down_revision: str | Sequence[str] | None = ('b8f2c6d91a04', 'f4a5b6c7d8e9')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Join the RyanAI head and the upstream v0.12.0 head.

    The upstream v0.12.0 chain (a7d3e9f2b641 -> ... -> b8f2c6d91a04) branches
    from d4c1a8e37b62, which f4a5b6c7d8e9 already contains. A database stamped
    at f4a5b6c7d8e9 therefore runs the upstream chain normally on its way to
    this revision, so no extra repair is needed here.
    """


def downgrade() -> None:
    pass
