import time
import uuid
from decimal import Decimal
from typing import List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import JSON, BigInteger, Column, Numeric, String

from open_webui.internal.db import Base, get_db

####################
# User Credit DB Schema
####################


class Credit(Base):
    __tablename__ = 'credit'

    id = Column(String, primary_key=True)
    user_id = Column(String, unique=True, nullable=False)
    credit = Column(Numeric(precision=24, scale=12))

    updated_at = Column(BigInteger)
    created_at = Column(BigInteger)


class CreditLog(Base):
    __tablename__ = 'credit_log'

    id = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    credit = Column(Numeric(precision=24, scale=12))
    detail = Column(JSON, nullable=True)

    created_at = Column(BigInteger, index=True)


####################
# Forms
####################


class CreditModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    user_id: str
    credit: Decimal = Field(default_factory=lambda: Decimal('0'))
    updated_at: int = Field(default_factory=lambda: int(time.time()))
    created_at: int = Field(default_factory=lambda: int(time.time()))


class CreditLogModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    user_id: str
    credit: Decimal = Field(default_factory=lambda: Decimal('0'))
    detail: dict = Field(default_factory=lambda: {})
    created_at: int = Field(default_factory=lambda: int(time.time()))


class CreditLogUsage(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra='allow')
    total_price: Optional[Decimal] = None
    prompt_unit_price: Optional[Decimal] = None
    completion_unit_price: Optional[Decimal] = None
    call_price: Optional[Decimal] = None
    feature_price: Optional[Decimal] = None
    completion_tokens: Optional[int] = None
    prompt_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class SimpleModelModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Optional[str] = None
    name: Optional[str] = None


class CreditLogSimpleDetailAPIParams(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    model: SimpleModelModel = Field(default_factory=lambda: {})


class CreditLogSimpleDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    desc: str = Field(default_factory=lambda: '')
    api_params: CreditLogSimpleDetailAPIParams = Field(default_factory=lambda: {})
    usage: CreditLogUsage = Field(default_factory=lambda: {})


class CreditLogSimpleModel(CreditLogModel):
    model_config = ConfigDict(from_attributes=True)
    detail: CreditLogSimpleDetail
    username: Optional[str] = Field(default='')


class SetCreditFormDetail(BaseModel):
    api_path: str = Field(default='')
    api_params: dict = Field(default_factory=lambda: {})
    desc: str = Field(default='')
    usage: dict = Field(default_factory=lambda: {})


class AddCreditForm(BaseModel):
    user_id: str
    amount: Decimal
    detail: SetCreditFormDetail


class SetCreditForm(BaseModel):
    user_id: str
    credit: Decimal
    detail: SetCreditFormDetail


####################
# Tables
####################


class CreditsTable:
    def insert_new_credit(self, user_id: str) -> Optional[CreditModel]:
        from open_webui.models.config import Config

        try:
            default_credit = Config.get_sync('credit.default_credit', '0')
            credit_model = CreditModel(user_id=user_id, credit=Decimal(str(default_credit)))
            with get_db() as db:
                result = Credit(**credit_model.model_dump())
                db.add(result)
                db.commit()
                db.refresh(result)
                if credit_model:
                    return credit_model
                return None
        except Exception:
            return None

    def init_credit_by_user_id(self, user_id: str) -> CreditModel:
        credit_model = self.get_credit_by_user_id(user_id=user_id) or self.insert_new_credit(user_id=user_id)
        if credit_model is not None:
            return credit_model
        raise HTTPException(status_code=500, detail='credit initialize failed')

    def get_credit_by_user_id(self, user_id: str) -> Optional[CreditModel]:
        try:
            with get_db() as db:
                credit = db.query(Credit).filter(Credit.user_id == user_id).first()
                return CreditModel.model_validate(credit)
        except Exception:
            return None

    def list_credits_by_user_id(self, user_ids: List[str]) -> List[CreditModel]:
        try:
            with get_db() as db:
                credits = db.query(Credit).filter(Credit.user_id.in_(user_ids)).all()
                return [CreditModel.model_validate(credit) for credit in credits]
        except Exception:
            return []

    def set_credit_by_user_id(self, form_data: SetCreditForm) -> CreditModel:
        credit_model = self.init_credit_by_user_id(user_id=form_data.user_id)
        log = CreditLogModel(
            user_id=form_data.user_id,
            credit=form_data.credit,
            detail=form_data.detail.model_dump(),
        )
        with get_db() as db:
            db.add(CreditLog(**log.model_dump()))
            db.query(Credit).filter(Credit.user_id == credit_model.user_id).update(
                {'credit': form_data.credit, 'updated_at': int(time.time())},
                synchronize_session=False,
            )
            db.commit()
        return self.get_credit_by_user_id(user_id=form_data.user_id)

    def add_credit_by_user_id(self, form_data: AddCreditForm) -> Optional[CreditModel]:
        credit_model = self.init_credit_by_user_id(user_id=form_data.user_id)
        log = CreditLogModel(
            user_id=form_data.user_id,
            credit=credit_model.credit + form_data.amount,
            detail=form_data.detail.model_dump(),
        )
        with get_db() as db:
            db.add(CreditLog(**log.model_dump()))
            db.query(Credit).filter(Credit.user_id == form_data.user_id).update(
                {
                    'credit': Credit.credit + form_data.amount,
                    'updated_at': int(time.time()),
                },
                synchronize_session=False,
            )
            db.commit()
        return self.get_credit_by_user_id(form_data.user_id)

    def reset_all_credits(self, value: Decimal) -> int:
        """Bulk-reset every user's credit to a fixed value (daily reset). Returns affected rows.

        Intentionally does NOT write per-user credit_log rows (a daily system reset over
        all users would otherwise flood the log). Users without a credit row are created
        lazily on their next activity using CREDIT_DEFAULT_CREDIT.
        """
        with get_db() as db:
            affected = (
                db.query(Credit)
                .update({'credit': value, 'updated_at': int(time.time())}, synchronize_session=False)
            )
            db.commit()
        return affected


Credits = CreditsTable()


class CreditLogTable:
    def count_credit_log(self, user_ids: list[str] = None) -> int:
        with get_db() as db:
            query = db.query(CreditLog).order_by(CreditLog.created_at.desc())
            if user_ids:
                query = query.filter(CreditLog.user_id.in_(user_ids))
            return query.count()

    def get_credit_log_by_page(
        self,
        user_ids: list[str] = None,
        offset: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> list[CreditLogSimpleModel]:
        with get_db() as db:
            query = db.query(CreditLog).order_by(CreditLog.created_at.desc())
            if user_ids:
                query = query.filter(CreditLog.user_id.in_(user_ids))
            if offset:
                query = query.offset(offset)
            if limit:
                query = query.limit(limit)
            all_logs = query.all()
            return [CreditLogSimpleModel.model_validate(log) for log in all_logs]

    def get_log_by_time(
        self, start_time: int, end_time: int, user_ids: Optional[List[str]] = None
    ) -> list[CreditLogSimpleModel]:
        try:
            with get_db() as db:
                logs = (
                    db.query(CreditLog)
                    .filter(CreditLog.created_at >= start_time)
                    .filter(CreditLog.created_at < end_time)
                )
                if user_ids:
                    logs = logs.filter(CreditLog.user_id.in_(user_ids))
                logs = logs.order_by(CreditLog.created_at.asc())
                return [CreditLogSimpleModel.model_validate(log) for log in logs]
        except Exception:
            return []

    def delete_log_by_timestamp(self, timestamp: int) -> int:
        try:
            with get_db() as db:
                query = db.query(CreditLog).filter(CreditLog.created_at < timestamp)
                total = query.count()
                query.delete()
                db.commit()
                return total
        except Exception as err:
            raise HTTPException(status_code=500, detail=str(err))


CreditLogs = CreditLogTable()
