"""restore the production compatibility revision

Revision ID: b5e7c9d1a2f3
Revises: a1b2c3d4e5f7
Create Date: 2026-08-11 18:00:00.000000

Some PostgreSQL deployments were stamped with this revision by an earlier
image build, but the revision file was not retained in the release history.
Keeping it as an explicit compatibility node lets those databases continue
through the normal migration chain without rewriting alembic_version.
"""

from collections.abc import Sequence

revision: str = 'b5e7c9d1a2f3'
down_revision: str | None = 'a1b2c3d4e5f7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
