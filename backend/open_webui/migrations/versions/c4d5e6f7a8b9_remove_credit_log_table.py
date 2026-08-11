"""retain the credit log table for history, audits, and rollback safety"""

from collections.abc import Sequence

revision: str = 'c4d5e6f7a8b9'
down_revision: str | None = 'b2c3d4e5f6a8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Credit history remains active and must survive upgrades and rollbacks.
    pass


def downgrade() -> None:
    pass
