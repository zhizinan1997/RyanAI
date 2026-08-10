"""remove credit log table"""

from collections.abc import Sequence

from alembic import op
from open_webui.migrations.util import get_existing_tables

revision: str = 'c4d5e6f7a8b9'
down_revision: str | None = 'b2c3d4e5f6a8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
	if 'credit_log' in get_existing_tables():
		op.drop_table('credit_log')


def downgrade() -> None:
	pass
