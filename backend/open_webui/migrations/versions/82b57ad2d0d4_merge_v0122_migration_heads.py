"""merge RyanAI and upstream v0.12.2 migration heads

Revision ID: 82b57ad2d0d4
Revises: 0bd252b206fb, c5a1d7e92f30
Create Date: 2026-10-16 00:00:00.000000

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = '82b57ad2d0d4'
down_revision: str | Sequence[str] | None = ('0bd252b206fb', 'c5a1d7e92f30')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Join the RyanAI head and the upstream v0.12.2 head.

    Upstream v0.12.1/v0.12.2 added c92da83b017f (apps) and 0bd252b206fb
    (missing auth rows) on top of b8f2c6d91a04, which c5a1d7e92f30 already
    contains. A database stamped at c5a1d7e92f30 runs those two revisions
    normally on its way to this one, so no extra repair is needed here.
    """


def downgrade() -> None:
    pass
