import time
import uuid
from typing import Optional

from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import BigInteger, Boolean, Column, Text, desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession


class Notification(Base):
    __tablename__ = 'notification'

    id = Column(Text, primary_key=True, unique=True)
    type = Column(Text, nullable=False)
    title = Column(Text, nullable=True)
    content = Column(Text, nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    dismissible = Column(Boolean, nullable=False, default=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)
    published_at = Column(BigInteger, nullable=True)


class NotificationModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    type: str
    title: Optional[str] = None
    content: str
    active: bool = True
    dismissible: bool = True
    created_at: int
    updated_at: int
    published_at: Optional[int] = None


class NotificationForm(BaseModel):
    type: str = 'info'
    title: Optional[str] = None
    content: str
    active: bool = True
    dismissible: bool = True
    published_at: Optional[int] = None


class NotificationUpdateForm(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    active: Optional[bool] = None
    dismissible: Optional[bool] = None
    published_at: Optional[int] = None


class NotificationListResponse(BaseModel):
    items: list[NotificationModel]
    total: int
    page: int
    limit: int


class NotificationTable:
    async def ensure_seeded_from_banners(
        self, banners: list, db: Optional[AsyncSession] = None
    ) -> None:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(func.count()).select_from(Notification))
            if result.scalar() > 0:
                return

            now = int(time.time())
            notifications = []
            for banner in banners or []:
                data = banner.model_dump() if hasattr(banner, 'model_dump') else dict(banner)
                content = data.get('content') or ''
                if content == '':
                    continue

                created_at = data.get('timestamp') or now
                notifications.append(
                    Notification(
                        id=data.get('id') or str(uuid.uuid4()),
                        type=data.get('type') or 'info',
                        title=data.get('title') or '',
                        content=content,
                        active=True,
                        dismissible=data.get('dismissible', True),
                        created_at=created_at,
                        updated_at=created_at,
                        published_at=created_at,
                    )
                )

            if notifications:
                db.add_all(notifications)
                await db.commit()

    async def get_notifications(
        self,
        page: int = 1,
        limit: int = 5,
        include_inactive: bool = True,
        db: Optional[AsyncSession] = None,
    ) -> NotificationListResponse:
        async with get_async_db_context(db) as db:
            page = max(page, 1)
            limit = min(max(limit, 1), 100)

            base_stmt = select(Notification)
            count_stmt = select(func.count()).select_from(Notification)
            if not include_inactive:
                base_stmt = base_stmt.where(Notification.active == True)
                count_stmt = count_stmt.where(Notification.active == True)

            total = (await db.execute(count_stmt)).scalar() or 0
            stmt = (
                base_stmt.order_by(
                    desc(Notification.active),
                    desc(func.coalesce(Notification.published_at, Notification.updated_at)),
                    desc(Notification.updated_at),
                )
                .offset((page - 1) * limit)
                .limit(limit)
            )
            result = await db.execute(stmt)
            items = [NotificationModel.model_validate(item) for item in result.scalars().all()]
            return NotificationListResponse(items=items, total=total, page=page, limit=limit)

    async def get_active_notifications(self, db: Optional[AsyncSession] = None) -> list[NotificationModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(Notification)
                .where(Notification.active == True)
                .order_by(desc(func.coalesce(Notification.published_at, Notification.updated_at)))
            )
            return [NotificationModel.model_validate(item) for item in result.scalars().all()]

    async def insert_new_notification(
        self, form_data: NotificationForm, db: Optional[AsyncSession] = None
    ) -> NotificationModel:
        async with get_async_db_context(db) as db:
            now = int(time.time())
            notification = Notification(
                id=str(uuid.uuid4()),
                type=form_data.type or 'info',
                title=form_data.title or '',
                content=form_data.content,
                active=form_data.active,
                dismissible=form_data.dismissible,
                created_at=now,
                updated_at=now,
                published_at=form_data.published_at or (now if form_data.active else None),
            )
            db.add(notification)
            await db.commit()
            await db.refresh(notification)
            return NotificationModel.model_validate(notification)

    async def update_notification_by_id(
        self, id: str, form_data: NotificationUpdateForm, db: Optional[AsyncSession] = None
    ) -> Optional[NotificationModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(Notification).where(Notification.id == id))
            notification = result.scalar_one_or_none()
            if notification is None:
                return None

            update_data = form_data.model_dump(exclude_unset=True)
            was_active = notification.active
            for key, value in update_data.items():
                setattr(notification, key, value)

            now = int(time.time())
            notification.updated_at = now
            if update_data.get('active') is True and not was_active and notification.published_at is None:
                notification.published_at = now

            await db.commit()
            await db.refresh(notification)
            return NotificationModel.model_validate(notification)

    async def set_notifications_from_banners(self, banners: list, db: Optional[AsyncSession] = None) -> list[NotificationModel]:
        async with get_async_db_context(db) as db:
            now = int(time.time())
            incoming_ids = set()

            for banner in banners:
                data = banner.model_dump() if hasattr(banner, 'model_dump') else dict(banner)
                id = data.get('id') or str(uuid.uuid4())
                incoming_ids.add(id)
                result = await db.execute(select(Notification).where(Notification.id == id))
                notification = result.scalar_one_or_none()
                timestamp = data.get('timestamp') or now
                if notification:
                    notification.type = data.get('type') or 'info'
                    notification.title = data.get('title') or ''
                    notification.content = data.get('content') or ''
                    notification.dismissible = data.get('dismissible', True)
                    notification.active = True
                    notification.updated_at = now
                    if notification.published_at is None:
                        notification.published_at = timestamp
                else:
                    db.add(
                        Notification(
                            id=id,
                            type=data.get('type') or 'info',
                            title=data.get('title') or '',
                            content=data.get('content') or '',
                            active=True,
                            dismissible=data.get('dismissible', True),
                            created_at=timestamp,
                            updated_at=now,
                            published_at=timestamp,
                        )
                    )

            if incoming_ids:
                await db.execute(
                    update(Notification).where(Notification.active == True, ~Notification.id.in_(incoming_ids)).values(
                        active=False, updated_at=now
                    )
                )
            else:
                await db.execute(update(Notification).where(Notification.active == True).values(active=False, updated_at=now))

            await db.commit()
            return await self.get_active_notifications(db=db)


Notifications = NotificationTable()
