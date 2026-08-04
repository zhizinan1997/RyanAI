import time
import uuid
from decimal import Decimal
from typing import List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import BigInteger, Column, Index, Numeric, String

from open_webui.internal.db import Base, get_db


class CheckinRecord(Base):
    """Daily check-in record. The legacy table name is kept for data compatibility."""

    __tablename__ = 'lottery_draw'

    id = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    checkin_date = Column('draw_date', String, index=True, nullable=False)
    reward = Column(Numeric(precision=24, scale=12))
    created_at = Column(BigInteger, index=True)

    __table_args__ = (Index('idx_lottery_user_date', 'user_id', 'draw_date', unique=True),)


class CheckinRecordModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    user_id: str
    checkin_date: str
    reward: Decimal = Field(default_factory=lambda: Decimal('0'))
    created_at: int = Field(default_factory=lambda: int(time.time()))


class CheckinRecordTable:
    def has_checked_in(self, user_id: str, checkin_date: str) -> bool:
        try:
            with get_db() as db:
                row = (
                    db.query(CheckinRecord)
                    .filter(
                        CheckinRecord.user_id == user_id,
                        CheckinRecord.checkin_date == checkin_date,
                    )
                    .first()
                )
                return row is not None
        except Exception:
            return False

    def insert(self, model: CheckinRecordModel) -> Optional[CheckinRecordModel]:
        try:
            with get_db() as db:
                row = CheckinRecord(**model.model_dump())
                db.add(row)
                db.commit()
                db.refresh(row)
                return CheckinRecordModel.model_validate(row)
        except Exception:
            return None

    def get_records(
        self, keyword: str = None, offset: int = None, limit: int = None
    ) -> Tuple[int, List[CheckinRecordModel]]:
        with get_db() as db:
            query = db.query(CheckinRecord).order_by(CheckinRecord.created_at.desc())
            if keyword:
                query = query.filter(CheckinRecord.user_id == keyword)
            total = query.count()
            if offset:
                query = query.offset(offset)
            if limit:
                query = query.limit(limit)
            return total, [CheckinRecordModel.model_validate(row) for row in query.all()]

    def get_user_records(self, user_id: str, limit: int = 30) -> List[CheckinRecordModel]:
        with get_db() as db:
            rows = (
                db.query(CheckinRecord)
                .filter(CheckinRecord.user_id == user_id)
                .order_by(CheckinRecord.created_at.desc())
                .limit(limit)
                .all()
            )
            return [CheckinRecordModel.model_validate(row) for row in rows]


CheckinRecords = CheckinRecordTable()
