"""retain the legacy credit log table for upgrade and rollback safety"""

from collections.abc import Sequence

revision: str = 'c4d5e6f7a8b9'
down_revision: str | None = 'b2c3d4e5f6a8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Newer code no longer writes credit_log, but existing rows are billing
    # history and must remain available for audits and database rollback.
    pass


def downgrade() -> None:
    pass
