import time
import uuid
from decimal import Decimal
from typing import List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import JSON, BigInteger, Column, Index, Numeric, String

from open_webui.internal.db import Base, get_db

####################
# Tarot Lottery DB Schema
####################


class LotteryDraw(Base):
    __tablename__ = 'lottery_draw'

    id = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    # date string (YYYY-MM-DD) in the configured lottery timezone; enforces one draw per day
    draw_date = Column(String, index=True, nullable=False)
    reward = Column(Numeric(precision=24, scale=12))
    cards = Column(JSON, nullable=True)  # [{"code": "ar00", "reversed": false}, ...]

    created_at = Column(BigInteger, index=True)

    __table_args__ = (Index('idx_lottery_user_date', 'user_id', 'draw_date', unique=True),)


####################
# Forms
####################


class LotteryDrawModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    user_id: str
    draw_date: str
    reward: Decimal = Field(default_factory=lambda: Decimal('0'))
    cards: list = Field(default_factory=list)
    created_at: int = Field(default_factory=lambda: int(time.time()))


####################
# Tables
####################


class LotteryDrawTable:
    def has_drawn(self, user_id: str, draw_date: str) -> bool:
        try:
            with get_db() as db:
                row = (
                    db.query(LotteryDraw)
                    .filter(LotteryDraw.user_id == user_id, LotteryDraw.draw_date == draw_date)
                    .first()
                )
                return row is not None
        except Exception:
            return False

    def insert_draw(self, model: LotteryDrawModel) -> Optional[LotteryDrawModel]:
        """Insert a draw record. Returns None on failure (e.g. unique constraint => already drawn)."""
        try:
            with get_db() as db:
                row = LotteryDraw(**model.model_dump())
                db.add(row)
                db.commit()
                db.refresh(row)
                return LotteryDrawModel.model_validate(row)
        except Exception:
            return None

    def get_draws(
        self, keyword: str = None, offset: int = None, limit: int = None
    ) -> Tuple[int, List[LotteryDrawModel]]:
        with get_db() as db:
            query = db.query(LotteryDraw).order_by(LotteryDraw.created_at.desc())
            if keyword:
                query = query.filter(LotteryDraw.user_id == keyword)
            total = query.count()
            if offset:
                query = query.offset(offset)
            if limit:
                query = query.limit(limit)
            return total, [LotteryDrawModel.model_validate(r) for r in query.all()]

    def get_user_draws(self, user_id: str, limit: int = 30) -> List[LotteryDrawModel]:
        with get_db() as db:
            rows = (
                db.query(LotteryDraw)
                .filter(LotteryDraw.user_id == user_id)
                .order_by(LotteryDraw.created_at.desc())
                .limit(limit)
                .all()
            )
            return [LotteryDrawModel.model_validate(r) for r in rows]


LotteryDraws = LotteryDrawTable()
