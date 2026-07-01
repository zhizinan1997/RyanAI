"""merge 0.10.1 migration heads

Revision ID: 8d3f2c9a1b7e
Revises: 42e2978c7933, c3d4e5f6a7b8
Create Date: 2026-07-01 15:02:00.000000

"""

from typing import Sequence, Union


revision: str = '8d3f2c9a1b7e'
down_revision: Union[str, tuple[str, str], None] = ('42e2978c7933', 'c3d4e5f6a7b8')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
