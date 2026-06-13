from __future__ import annotations

import logging
import time

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, Column, Index, String, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


class EmailVerification(Base):
    __tablename__ = 'email_verification'

    code_hash = Column(String(64), primary_key=True)
    email = Column(String(320), nullable=False)
    expires_at = Column(BigInteger, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    used_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index('idx_email_verification_email', 'email'),
        Index('idx_email_verification_expires_at', 'expires_at'),
    )


class EmailVerificationModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code_hash: str
    email: str
    expires_at: int
    created_at: int
    used_at: int | None = None


class EmailVerificationTable:
    async def create_verification(
        self,
        email: str,
        code_hash: str,
        expires_at: int,
        db: AsyncSession | None = None,
    ) -> EmailVerificationModel | None:
        try:
            async with get_async_db_context(db) as session:
                now = int(time.time())
                normalized_email = email.lower()

                await session.execute(
                    delete(EmailVerification).where(
                        or_(
                            EmailVerification.email == normalized_email,
                            EmailVerification.expires_at < now,
                            EmailVerification.used_at.is_not(None),
                        )
                    )
                )

                verification = EmailVerification(
                    code_hash=code_hash,
                    email=normalized_email,
                    expires_at=expires_at,
                    created_at=now,
                    used_at=None,
                )
                session.add(verification)
                await session.commit()
                await session.refresh(verification)
                return EmailVerificationModel.model_validate(verification)
        except Exception as e:
            log.error(f'Error creating email verification: {e}')
            return None

    async def consume_code(
        self,
        code_hash: str,
        db: AsyncSession | None = None,
    ) -> str | None:
        try:
            async with get_async_db_context(db) as session:
                result = await session.execute(
                    select(EmailVerification)
                    .where(EmailVerification.code_hash == code_hash)
                    .with_for_update()
                )
                verification = result.scalars().first()
                if not verification:
                    return None

                now = int(time.time())
                if verification.used_at is not None:
                    return None

                if verification.expires_at < now:
                    await session.delete(verification)
                    await session.commit()
                    return None

                email = verification.email
                verification.used_at = now
                await session.commit()
                return email
        except Exception as e:
            log.error(f'Error consuming email verification: {e}')
            return None


EmailVerifications = EmailVerificationTable()
