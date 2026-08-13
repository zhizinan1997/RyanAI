"""Database models and data access for the WeChat/QQ message gateway."""

from __future__ import annotations

import json
import time
from typing import Any, Literal
from uuid import uuid4

from open_webui.internal.db import Base, get_async_db_context
from open_webui.models.users import User
from open_webui.utils.bot_gateway_crypto import (
    BotGatewayCredentialError,
    credential_account_digest,
    decrypt_bot_checkpoint,
    decrypt_bot_credentials,
    encrypt_bot_checkpoint,
    encrypt_bot_credentials,
    extract_account_key,
)
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Column,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    and_,
    delete,
    desc,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

BotGatewayChannel = Literal['wechat', 'qq']
BotGatewayConversationType = Literal['private', 'group']

BOT_GATEWAY_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60
BOT_GATEWAY_BINDING_CODE_RETENTION_SECONDS = 24 * 60 * 60
BOT_GATEWAY_CLEANUP_INTERVAL_SECONDS = 10 * 60


class BotGatewayConnection(Base):
    __tablename__ = 'bot_gateway_connection'

    id = Column(String, primary_key=True, unique=True)
    channel = Column(String, nullable=False)
    name = Column(Text, nullable=False)
    enabled = Column(Boolean, nullable=False, default=False)
    status = Column(String, nullable=False, default='logged_out')
    credentials_configured = Column(Boolean, nullable=False, default=False)
    account_id = Column(Text, nullable=True)
    account_name = Column(Text, nullable=True)
    config = Column(JSON, nullable=True)
    last_error = Column(Text, nullable=True)
    last_seen_at = Column(BigInteger, nullable=True)
    created_by = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    owner_user_id = Column(String, ForeignKey('user.id', ondelete='CASCADE'), nullable=True)
    shard_id = Column(String, nullable=True)
    account_key = Column(Text, nullable=True)
    assignment_generation = Column(Integer, nullable=True, default=0)
    last_runtime_node_id = Column(String, nullable=True)
    last_runtime_at = Column(BigInteger, nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        Index('ix_bot_gateway_connection_channel_enabled', 'channel', 'enabled'),
        Index('ix_bot_gateway_connection_status', 'status'),
    )


class BotGatewayBinding(Base):
    __tablename__ = 'bot_gateway_binding'

    id = Column(String, primary_key=True, unique=True)
    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        nullable=False,
    )
    user_id = Column(String, ForeignKey('user.id', ondelete='CASCADE'), nullable=False)
    external_user_id = Column(Text, nullable=False)
    display_name = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    blocked = Column(Boolean, nullable=False, default=False)
    blocked_at = Column(BigInteger, nullable=True)
    blocked_by = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    unbind_requested_at = Column(BigInteger, nullable=True)
    last_seen_at = Column(BigInteger, nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            'connection_id',
            'external_user_id',
            name='uq_bot_gateway_binding_connection_identity',
        ),
        Index('ix_bot_gateway_binding_user_enabled', 'user_id', 'enabled'),
        Index('ix_bot_gateway_binding_connection_enabled', 'connection_id', 'enabled'),
    )


class BotGatewayConversation(Base):
    __tablename__ = 'bot_gateway_conversation'

    id = Column(String, primary_key=True, unique=True)
    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        nullable=False,
    )
    binding_id = Column(
        String,
        ForeignKey('bot_gateway_binding.id', ondelete='CASCADE'),
        nullable=False,
    )
    user_id = Column(String, ForeignKey('user.id', ondelete='CASCADE'), nullable=False)
    conversation_type = Column(String, nullable=False)
    external_conversation_id = Column(Text, nullable=False)
    external_sender_id = Column(Text, nullable=False, default='')
    session_key = Column(Text, nullable=False)
    chat_id = Column(String, ForeignKey('chat.id', ondelete='SET NULL'), nullable=True)
    model_id = Column(Text, nullable=True)
    last_event_at = Column(BigInteger, nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint('binding_id', 'session_key', name='uq_bot_gateway_conversation_binding_session'),
        Index('ix_bot_gateway_conversation_chat', 'chat_id'),
        Index('ix_bot_gateway_conversation_connection_scope', 'connection_id', 'conversation_type'),
    )


class BotGatewayBindingCode(Base):
    __tablename__ = 'bot_gateway_binding_code'

    id = Column(String, primary_key=True, unique=True)
    user_id = Column(String, ForeignKey('user.id', ondelete='CASCADE'), nullable=False)
    channel = Column(String, nullable=True)
    code_hash = Column(String(64), nullable=False, unique=True)
    expires_at = Column(BigInteger, nullable=False)
    consumed_at = Column(BigInteger, nullable=True)
    consumed_by_binding_id = Column(
        String,
        ForeignKey('bot_gateway_binding.id', ondelete='SET NULL'),
        nullable=True,
    )
    created_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        Index('ix_bot_gateway_binding_code_user_expires', 'user_id', 'expires_at'),
        Index('ix_bot_gateway_binding_code_channel_expires', 'channel', 'expires_at'),
    )


class BotGatewayGroup(Base):
    __tablename__ = 'bot_gateway_group'

    id = Column(String, primary_key=True, unique=True)
    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        nullable=False,
    )
    external_group_id = Column(Text, nullable=False)
    name = Column(Text, nullable=True)
    allowed = Column(Boolean, nullable=False, default=False)
    member_count = Column(Integer, nullable=True)
    discovered_at = Column(BigInteger, nullable=True)
    last_seen_at = Column(BigInteger, nullable=True)
    updated_by = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            'connection_id',
            'external_group_id',
            name='uq_bot_gateway_group_connection_group',
        ),
        Index('ix_bot_gateway_group_connection_allowed', 'connection_id', 'allowed'),
        Index('ix_bot_gateway_group_connection_seen', 'connection_id', 'last_seen_at'),
    )


class BotGatewayEvent(Base):
    __tablename__ = 'bot_gateway_event'

    id = Column(String, primary_key=True, unique=True)
    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        nullable=False,
    )
    event_id = Column(Text, nullable=False)
    request_hash = Column(String(64), nullable=False)
    request_nonce = Column(String(128), nullable=False)
    status = Column(String, nullable=False, default='processing')
    conversation_type = Column(String, nullable=True)
    external_conversation_id = Column(Text, nullable=True)
    external_sender_id = Column(Text, nullable=True)
    binding_id = Column(
        String,
        ForeignKey('bot_gateway_binding.id', ondelete='SET NULL'),
        nullable=True,
    )
    conversation_id = Column(
        String,
        ForeignKey('bot_gateway_conversation.id', ondelete='SET NULL'),
        nullable=True,
    )
    chat_id = Column(String, ForeignKey('chat.id', ondelete='SET NULL'), nullable=True)
    assistant_message_id = Column(String, nullable=True)
    response = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    attempts = Column(Integer, nullable=False, default=1)
    received_at = Column(BigInteger, nullable=False)
    completed_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint('connection_id', 'event_id', name='uq_bot_gateway_event_connection_event'),
        Index('ix_bot_gateway_event_status_received', 'status', 'received_at'),
        Index('ix_bot_gateway_event_updated', 'updated_at'),
        Index('ix_bot_gateway_event_connection_received', 'connection_id', 'received_at'),
        Index('ix_bot_gateway_event_nonce', 'request_nonce'),
    )


class BotGatewayRequestNonce(Base):
    __tablename__ = 'bot_gateway_request_nonce'

    nonce = Column(String(128), primary_key=True)
    expires_at = Column(BigInteger, nullable=False)
    created_at = Column(BigInteger, nullable=False)

    __table_args__ = (Index('ix_bot_gateway_request_nonce_expires', 'expires_at'),)


class BotGatewayUserSetting(Base):
    """Per-user gateway preferences, deliberately separate from UI settings."""

    __tablename__ = 'bot_gateway_user_setting'

    user_id = Column(String, ForeignKey('user.id', ondelete='CASCADE'), primary_key=True)
    default_model_id = Column(Text, nullable=True)
    updated_at = Column(BigInteger, nullable=False)


class BotGatewayBindingHistory(Base):
    """Immutable audit trail for user-owned bot connections and bindings."""

    __tablename__ = 'bot_gateway_binding_history'

    id = Column(String, primary_key=True, unique=True)
    user_id = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    connection_id = Column(String, ForeignKey('bot_gateway_connection.id', ondelete='SET NULL'), nullable=True)
    channel = Column(String, nullable=False)
    external_user_id = Column(Text, nullable=True)
    display_name = Column(Text, nullable=True)
    action = Column(String, nullable=False)
    actor_user_id = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    metadata_json = Column('metadata', JSON, nullable=True)
    created_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        Index('ix_bot_gateway_binding_history_user_created', 'user_id', 'created_at'),
        Index('ix_bot_gateway_binding_history_connection_created', 'connection_id', 'created_at'),
    )


class BotGatewayCredential(Base):
    """Encrypted per-connection credentials; ciphertext only, decrypted in-process."""

    __tablename__ = 'bot_gateway_credential'

    id = Column(String, primary_key=True, unique=True)
    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        nullable=False,
        unique=True,
    )
    channel = Column(String, nullable=False)
    account_digest = Column(String(64), nullable=False)
    envelope = Column(Text, nullable=False)
    key_version = Column(Integer, nullable=False, default=1)
    schema_version = Column(Integer, nullable=False, default=1)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint('account_digest', name='uq_bot_gateway_credential_account_digest'),
        Index('ix_bot_gateway_credential_channel', 'channel'),
    )


class BotGatewayShard(Base):
    """Logical shard metadata for gateway account distribution."""

    __tablename__ = 'bot_gateway_shard'

    id = Column(String, primary_key=True, unique=True)
    channel = Column(String, nullable=False)
    account_capacity = Column(Integer, nullable=False, default=12)
    load_capacity = Column(Integer, nullable=False, default=12)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)


class BotGatewayNode(Base):
    """Registered gateway runtime node; single-node deployments keep one row."""

    __tablename__ = 'bot_gateway_node'

    id = Column(String, primary_key=True, unique=True)
    advertise_url = Column(Text, nullable=True)
    capabilities = Column(JSON, nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)
    last_seen_at = Column(BigInteger, nullable=True)


class BotGatewayAccountCheckpoint(Base):
    """Latest known account state per connection, used for shard rebalancing."""

    __tablename__ = 'bot_gateway_account_checkpoint'

    connection_id = Column(
        String,
        ForeignKey('bot_gateway_connection.id', ondelete='CASCADE'),
        primary_key=True,
    )
    payload = Column(Text, nullable=False)
    payload_sha256 = Column(String(64), nullable=False)
    updated_at = Column(BigInteger, nullable=False)


class BotGatewayControlOperation(Base):
    """Audit carrier for administrative gateway operations (drain, circuit reset, ...).

    There is no generic audit table today (BotGatewayBindingHistory only covers
    binding history), so this table doubles as the control-plane audit trail.
    """

    __tablename__ = 'bot_gateway_control_operation'

    id = Column(String, primary_key=True, unique=True)
    kind = Column(String, nullable=False)
    payload = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default='pending')
    actor_user_id = Column(String, ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)
    completed_at = Column(BigInteger, nullable=True)


class BotGatewayConnectionModel(BaseModel):
    id: str
    channel: BotGatewayChannel
    name: str
    enabled: bool = False
    status: str = 'logged_out'
    credentials_configured: bool = False
    account_id: str | None = None
    account_name: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    last_error: str | None = None
    last_seen_at: int | None = None
    created_by: str | None = None
    owner_user_id: str | None = None
    shard_id: str | None = None
    account_key: str | None = None
    assignment_generation: int = 0
    last_runtime_node_id: str | None = None
    last_runtime_at: int | None = None
    created_at: int
    updated_at: int

    @field_validator('assignment_generation', mode='before')
    @classmethod
    def normalize_assignment_generation(cls, value):
        return 0 if value is None else value

    model_config = ConfigDict(from_attributes=True)


class BotGatewayUserSettingModel(BaseModel):
    user_id: str
    default_model_id: str | None = None
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayBindingHistoryModel(BaseModel):
    id: str
    user_id: str | None = None
    connection_id: str | None = None
    channel: BotGatewayChannel
    external_user_id: str | None = None
    display_name: str | None = None
    action: str
    actor_user_id: str | None = None
    metadata: dict[str, Any] | None = Field(default=None, validation_alias='metadata_json')
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayCredentialModel(BaseModel):
    # The envelope (ciphertext) is deliberately absent: it never leaves the
    # credential table through API models.
    id: str
    connection_id: str
    channel: BotGatewayChannel
    account_digest: str
    key_version: int = 1
    schema_version: int = 1
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayShardModel(BaseModel):
    id: str
    channel: BotGatewayChannel
    account_capacity: int = 12
    load_capacity: int = 12
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayNodeModel(BaseModel):
    id: str
    advertise_url: str | None = None
    capabilities: dict[str, Any] | None = None
    created_at: int
    updated_at: int
    last_seen_at: int | None = None

    model_config = ConfigDict(from_attributes=True)


class BotGatewayAccountCheckpointModel(BaseModel):
    connection_id: str
    payload: str
    payload_sha256: str
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayControlOperationModel(BaseModel):
    id: str
    kind: str
    payload: dict[str, Any] | None = None
    status: str = 'pending'
    actor_user_id: str | None = None
    created_at: int
    updated_at: int
    completed_at: int | None = None

    model_config = ConfigDict(from_attributes=True)


class BotGatewayBindingModel(BaseModel):
    id: str
    connection_id: str
    user_id: str
    external_user_id: str
    display_name: str | None = None
    enabled: bool = True
    blocked: bool = False
    blocked_at: int | None = None
    blocked_by: str | None = None
    unbind_requested_at: int | None = None
    last_seen_at: int | None = None
    created_at: int
    updated_at: int
    is_new_binding: bool = Field(default=False, exclude=True)

    model_config = ConfigDict(from_attributes=True)


class BotGatewayBindingView(BotGatewayBindingModel):
    channel: BotGatewayChannel
    status: str


class BotGatewayConversationModel(BaseModel):
    id: str
    connection_id: str
    binding_id: str
    user_id: str
    conversation_type: BotGatewayConversationType
    external_conversation_id: str
    external_sender_id: str = ''
    session_key: str
    chat_id: str | None = None
    model_id: str | None = None
    last_event_at: int | None = None
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayGroupModel(BaseModel):
    id: str
    connection_id: str
    external_group_id: str
    name: str | None = None
    allowed: bool = False
    member_count: int | None = None
    discovered_at: int | None = None
    last_seen_at: int | None = None
    updated_by: str | None = None
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayEventModel(BaseModel):
    id: str
    connection_id: str
    event_id: str
    request_hash: str
    request_nonce: str
    status: str
    conversation_type: str | None = None
    external_conversation_id: str | None = None
    external_sender_id: str | None = None
    binding_id: str | None = None
    conversation_id: str | None = None
    chat_id: str | None = None
    assistant_message_id: str | None = None
    response: dict[str, Any] | None = None
    error: str | None = None
    attempts: int = 1
    received_at: int
    completed_at: int | None = None
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class BotGatewayBindingError(ValueError):
    """Raised when a binding code cannot be consumed safely."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class BotGatewayEventConflictError(ValueError):
    """Raised when an idempotency key is reused with a different request."""


def build_bot_gateway_session_key(
    conversation_type: BotGatewayConversationType,
    conversation_id: str,
    sender_id: str,
) -> tuple[str, str, str]:
    """Return the durable session key plus normalized conversation/sender IDs."""
    if conversation_type == 'private':
        return f'private:{sender_id}', sender_id, ''
    return f'group:{conversation_id}:{sender_id}', conversation_id, sender_id


class BotGatewayCredentialTable:
    async def save_credential(
        self,
        db: AsyncSession | None,
        connection_id: str,
        channel: BotGatewayChannel,
        credentials: dict[str, Any],
    ) -> dict[str, Any]:
        """Encrypt and upsert one connection's credentials.

        The account_digest unique constraint is the concurrency primitive: a
        conflict from another connection raises BotGatewayBindingError with
        code 'account_already_bound'; a conflict for the same connection is a
        benign race that resolves into the update path.
        """
        digest = credential_account_digest(channel, extract_account_key(channel, credentials))
        envelope = json.dumps(encrypt_bot_credentials(credentials, connection_id, channel))
        now = int(time.time())
        async with get_async_db_context(db) as session:
            item = (
                (
                    await session.execute(
                        select(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
                    )
                )
                .scalars()
                .first()
            )
            if item is not None:
                item.envelope = envelope
                item.channel = channel
                item.account_digest = digest
                item.updated_at = now
                try:
                    await session.commit()
                except IntegrityError:
                    await session.rollback()
                    await self._resolve_digest_conflict(session, connection_id, digest, envelope, channel, now)
                return {'connection_id': connection_id, 'channel': channel, 'account_digest': digest}
            session.add(
                BotGatewayCredential(
                    id=str(uuid4()),
                    connection_id=connection_id,
                    channel=channel,
                    account_digest=digest,
                    envelope=envelope,
                    key_version=1,
                    schema_version=1,
                    created_at=now,
                    updated_at=now,
                )
            )
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                await self._resolve_digest_conflict(session, connection_id, digest, envelope, channel, now)
            return {'connection_id': connection_id, 'channel': channel, 'account_digest': digest}

    async def _resolve_digest_conflict(
        self,
        session: AsyncSession,
        connection_id: str,
        digest: str,
        envelope: str,
        channel: BotGatewayChannel,
        now: int,
    ) -> None:
        existing = (
            (await session.execute(select(BotGatewayCredential).where(BotGatewayCredential.account_digest == digest)))
            .scalars()
            .first()
        )
        if existing is not None:
            if existing.connection_id == connection_id:
                existing.envelope = envelope
                existing.channel = channel
                existing.updated_at = now
                await session.commit()
                return
            raise BotGatewayBindingError('account_already_bound')
        # The conflict came from the connection_id unique constraint: another
        # writer created the row for this same connection concurrently.
        existing = (
            (
                await session.execute(
                    select(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
                )
            )
            .scalars()
            .first()
        )
        if existing is not None:
            existing.envelope = envelope
            existing.channel = channel
            existing.account_digest = digest
            existing.updated_at = now
            await session.commit()
            return
        raise RuntimeError(f'credential upsert lost the race for connection {connection_id}')

    async def get_credential(self, db: AsyncSession | None, connection_id: str) -> dict[str, Any] | None:
        """Return decrypted credentials for internal gateway use only.

        Never expose the return value through user-facing APIs.
        """
        async with get_async_db_context(db) as session:
            item = (
                (
                    await session.execute(
                        select(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
                    )
                )
                .scalars()
                .first()
            )
            if item is None:
                return None
            try:
                envelope = json.loads(item.envelope)
            except json.JSONDecodeError as exc:
                raise BotGatewayCredentialError('stored credential envelope is corrupt') from exc
            return decrypt_bot_credentials(envelope, connection_id, item.channel)

    async def delete_credential(self, db: AsyncSession | None, connection_id: str) -> None:
        async with get_async_db_context(db) as session:
            await session.execute(
                delete(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
            )
            await session.commit()

    async def list_credential_digests(self, db: AsyncSession | None = None) -> list[dict[str, str]]:
        """Admin view of stored credentials: connection/channel/digest only, never plaintext."""
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(
                    BotGatewayCredential.connection_id,
                    BotGatewayCredential.channel,
                    BotGatewayCredential.account_digest,
                )
            )
            return [
                {'connection_id': connection_id, 'channel': channel, 'account_digest': digest}
                for connection_id, channel, digest in result.all()
            ]

    async def connection_has_credential(self, db: AsyncSession | None, connection_id: str) -> bool:
        async with get_async_db_context(db) as session:
            item = await session.scalar(
                select(BotGatewayCredential.id).where(BotGatewayCredential.connection_id == connection_id)
            )
            return item is not None


class BotGatewayCheckpointTable:
    async def save(self, db: AsyncSession | None, connection_id: str, payload: bytes, sha256: str) -> None:
        envelope = json.dumps(encrypt_bot_checkpoint(payload, connection_id), separators=(',', ':'))
        now = int(time.time())
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayAccountCheckpoint, connection_id)
            if item is None:
                session.add(
                    BotGatewayAccountCheckpoint(
                        connection_id=connection_id,
                        payload=envelope,
                        payload_sha256=sha256,
                        updated_at=now,
                    )
                )
            else:
                item.payload = envelope
                item.payload_sha256 = sha256
                item.updated_at = now
            await session.commit()

    async def get(self, db: AsyncSession | None, connection_id: str) -> tuple[bytes, str] | None:
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayAccountCheckpoint, connection_id)
            if item is None:
                return None
            try:
                envelope = json.loads(item.payload)
            except json.JSONDecodeError as exc:
                raise BotGatewayCredentialError('stored checkpoint envelope is corrupt') from exc
            return decrypt_bot_checkpoint(envelope, connection_id), item.payload_sha256


class BotGatewayTable:
    def __init__(self) -> None:
        self._next_cleanup_at = 0

    async def ensure_default_connections(
        self,
        db: AsyncSession | None = None,
    ) -> list[BotGatewayConnectionModel]:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            defaults = (
                ('wechat-default', 'wechat', '个人微信机器人'),
                ('qq-default', 'qq', '个人 QQ 机器人'),
            )
            changed = False
            for connection_id, channel, name in defaults:
                if await session.get(BotGatewayConnection, connection_id) is None:
                    session.add(
                        BotGatewayConnection(
                            id=connection_id,
                            channel=channel,
                            name=name,
                            enabled=False,
                            status='logged_out',
                            credentials_configured=False,
                            config={},
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    changed = True
            if changed:
                await session.commit()
            result = await session.execute(select(BotGatewayConnection).order_by(BotGatewayConnection.channel))
            return [BotGatewayConnectionModel.model_validate(item) for item in result.scalars().all()]

    async def list_connections(self, db: AsyncSession | None = None) -> list[BotGatewayConnectionModel]:
        async with get_async_db_context(db) as session:
            result = await session.execute(select(BotGatewayConnection).order_by(BotGatewayConnection.channel))
            return [BotGatewayConnectionModel.model_validate(item) for item in result.scalars().all()]

    async def get_connection(
        self,
        connection_id: str,
        db: AsyncSession | None = None,
    ) -> BotGatewayConnectionModel | None:
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayConnection, connection_id)
            return BotGatewayConnectionModel.model_validate(item) if item else None

    async def get_user_connection(self, user_id: str, channel: BotGatewayChannel, db: AsyncSession | None = None):
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(BotGatewayConnection).where(
                    BotGatewayConnection.owner_user_id == user_id,
                    BotGatewayConnection.channel == channel,
                )
            )
            item = result.scalars().first()
            return BotGatewayConnectionModel.model_validate(item) if item else None

    async def ensure_user_connection(
        self, user_id: str, channel: BotGatewayChannel, *, enabled: bool = True, db: AsyncSession | None = None
    ) -> BotGatewayConnectionModel:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(BotGatewayConnection).where(
                    BotGatewayConnection.owner_user_id == user_id,
                    BotGatewayConnection.channel == channel,
                )
            )
            item = result.scalars().first()
            now = int(time.time())
            if item is None:
                item = BotGatewayConnection(
                    id=f'bot-{channel}-{user_id}',
                    channel=channel,
                    name=f'{channel} bot',
                    enabled=enabled,
                    status='logged_out',
                    credentials_configured=False,
                    config={},
                    created_by=user_id,
                    owner_user_id=user_id,
                    created_at=now,
                    updated_at=now,
                )
                session.add(item)
            else:
                item.enabled = enabled
                item.updated_at = now
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                result = await session.execute(
                    select(BotGatewayConnection).where(
                        BotGatewayConnection.owner_user_id == user_id,
                        BotGatewayConnection.channel == channel,
                    )
                )
                item = result.scalars().first()
                if item is None:
                    raise
            await session.refresh(item)
            return BotGatewayConnectionModel.model_validate(item)

    async def get_user_setting(self, user_id: str, db: AsyncSession | None = None) -> BotGatewayUserSettingModel:
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayUserSetting, user_id)
            if item is None:
                item = BotGatewayUserSetting(user_id=user_id, default_model_id=None, updated_at=int(time.time()))
                session.add(item)
                await session.commit()
                await session.refresh(item)
            return BotGatewayUserSettingModel.model_validate(item)

    async def update_user_setting(self, user_id: str, default_model_id: str | None, db: AsyncSession | None = None):
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayUserSetting, user_id)
            if item is None:
                item = BotGatewayUserSetting(
                    user_id=user_id, default_model_id=default_model_id, updated_at=int(time.time())
                )
                session.add(item)
            else:
                item.default_model_id = default_model_id
                item.updated_at = int(time.time())
            await session.commit()
            await session.refresh(item)
            return BotGatewayUserSettingModel.model_validate(item)

    async def add_binding_history(
        self,
        *,
        channel: BotGatewayChannel,
        action: str,
        user_id: str | None = None,
        connection_id: str | None = None,
        external_user_id: str | None = None,
        display_name: str | None = None,
        actor_user_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        db: AsyncSession | None = None,
    ) -> None:
        async with get_async_db_context(db) as session:
            session.add(
                BotGatewayBindingHistory(
                    id=str(uuid4()),
                    user_id=user_id,
                    connection_id=connection_id,
                    channel=channel,
                    external_user_id=external_user_id,
                    display_name=display_name,
                    action=action,
                    actor_user_id=actor_user_id,
                    metadata_json=metadata,
                    created_at=int(time.time()),
                )
            )
            await session.commit()

    async def list_binding_history(
        self, *, user_id: str | None = None, limit: int = 100, db: AsyncSession | None = None
    ):
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayBindingHistory).order_by(desc(BotGatewayBindingHistory.created_at)).limit(limit)
            if user_id is not None:
                stmt = stmt.where(BotGatewayBindingHistory.user_id == user_id)
            result = await session.execute(stmt)
            return [BotGatewayBindingHistoryModel.model_validate(item) for item in result.scalars().all()]

    async def update_connection(
        self,
        connection_id: str,
        values: dict[str, Any],
        db: AsyncSession | None = None,
        *,
        touch_updated_at: bool = True,
    ) -> BotGatewayConnectionModel | None:
        allowed = {
            'enabled',
            'status',
            'credentials_configured',
            'account_id',
            'account_name',
            'config',
            'last_error',
            'last_seen_at',
            'name',
        }
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayConnection, connection_id)
            if item is None:
                return None
            for key, value in values.items():
                if key in allowed:
                    setattr(item, key, value)
            if touch_updated_at:
                item.updated_at = int(time.time())
            await session.commit()
            return BotGatewayConnectionModel.model_validate(item)

    async def clear_connection_credentials(
        self,
        connection_id: str,
        db: AsyncSession | None = None,
    ) -> BotGatewayConnectionModel | None:
        """Clear durable account state and invalidate the current runtime assignment."""
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayConnection).where(BotGatewayConnection.id == connection_id)
            if session.bind and session.bind.dialect.name == 'postgresql':
                stmt = stmt.with_for_update()
            item = (await session.execute(stmt)).scalars().first()
            if item is None:
                return None

            await session.execute(
                delete(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
            )
            await session.execute(
                delete(BotGatewayAccountCheckpoint).where(
                    BotGatewayAccountCheckpoint.connection_id == connection_id
                )
            )

            runtime_config_keys = {
                'account_error_streak',
                'control_operation_in_progress',
                'credential_migration_in_progress',
                'half_open',
                'last_shard_move_at',
                'overloaded_windows',
                'runtime_metrics',
                'scheduler_window_minute',
                'trusted_external_user_id',
                'underloaded_windows',
            }
            item.config = {
                key: value
                for key, value in (item.config if isinstance(item.config, dict) else {}).items()
                if key not in runtime_config_keys
            }
            item.status = 'logged_out'
            item.credentials_configured = False
            item.account_id = None
            item.account_name = None
            item.account_key = None
            item.shard_id = None
            item.last_error = None
            item.last_seen_at = None
            item.last_runtime_node_id = None
            item.last_runtime_at = None
            item.assignment_generation = int(item.assignment_generation or 0) + 1
            item.updated_at = int(time.time())
            await session.commit()
            return BotGatewayConnectionModel.model_validate(item)

    async def delete_owned_connection(
        self,
        connection_id: str,
        owner_user_id: str,
        db: AsyncSession | None = None,
    ) -> bool:
        """Delete a personal connection and its dependents without relying on FK cascades."""
        async with get_async_db_context(db) as session:
            ownership_stmt = select(BotGatewayConnection.id).where(
                BotGatewayConnection.id == connection_id,
                BotGatewayConnection.owner_user_id == owner_user_id,
            )
            if session.bind and session.bind.dialect.name == 'postgresql':
                ownership_stmt = ownership_stmt.with_for_update()
            if await session.scalar(ownership_stmt) is None:
                return False

            binding_ids = select(BotGatewayBinding.id).where(
                BotGatewayBinding.connection_id == connection_id
            )
            await session.execute(
                delete(BotGatewayEvent).where(BotGatewayEvent.connection_id == connection_id)
            )
            await session.execute(
                delete(BotGatewayConversation).where(
                    BotGatewayConversation.connection_id == connection_id
                )
            )
            await session.execute(
                update(BotGatewayBindingCode)
                .where(BotGatewayBindingCode.consumed_by_binding_id.in_(binding_ids))
                .values(consumed_by_binding_id=None)
            )
            await session.execute(
                delete(BotGatewayBinding).where(BotGatewayBinding.connection_id == connection_id)
            )
            await session.execute(
                delete(BotGatewayGroup).where(BotGatewayGroup.connection_id == connection_id)
            )
            await session.execute(
                delete(BotGatewayCredential).where(BotGatewayCredential.connection_id == connection_id)
            )
            await session.execute(
                delete(BotGatewayAccountCheckpoint).where(
                    BotGatewayAccountCheckpoint.connection_id == connection_id
                )
            )
            await session.execute(
                update(BotGatewayBindingHistory)
                .where(BotGatewayBindingHistory.connection_id == connection_id)
                .values(connection_id=None)
            )
            result = await session.execute(
                delete(BotGatewayConnection).where(
                    BotGatewayConnection.id == connection_id,
                    BotGatewayConnection.owner_user_id == owner_user_id,
                )
            )
            if result.rowcount != 1:
                await session.rollback()
                return False
            await session.commit()
            return True

    async def update_connection_runtime_metrics(
        self,
        node_id: str,
        metrics_by_connection: dict[str, dict[str, float | int]],
        *,
        load_capacity: int = 12,
        db: AsyncSession | None = None,
    ) -> int:
        if not metrics_by_connection:
            return 0
        from open_webui.utils.bot_gateway_scheduler import (
            calculate_load_units,
            load_sample_from_config,
        )

        now = int(time.time())
        minute = now // 60
        async with get_async_db_context(db) as session:
            result = await session.execute(select(BotGatewayConnection).where(BotGatewayConnection.enabled.is_(True)))
            items = list(result.scalars().all())
            by_id = {item.id: item for item in items}
            for connection_id, metrics in metrics_by_connection.items():
                item = by_id.get(connection_id)
                if item is None:
                    continue
                config = dict(item.config) if isinstance(item.config, dict) else {}
                config['runtime_metrics'] = metrics
                config['account_error_streak'] = int(metrics.get('account_error_streak', 0) or 0)
                item.config = config
                item.last_runtime_node_id = node_id
                item.last_runtime_at = now

            shard_load: dict[str, int] = {}
            for item in items:
                if not item.shard_id:
                    continue
                config = item.config if isinstance(item.config, dict) else {}
                shard_load[item.shard_id] = shard_load.get(item.shard_id, 0) + calculate_load_units(
                    load_sample_from_config(config)
                )
            sticky_limit = int(load_capacity * 1.2)
            low_limit = load_capacity * 0.4
            updated = 0
            for connection_id in metrics_by_connection:
                item = by_id.get(connection_id)
                if item is None:
                    continue
                config = dict(item.config) if isinstance(item.config, dict) else {}
                if config.get('scheduler_window_minute') != minute:
                    load = shard_load.get(item.shard_id or '', 0)
                    config['overloaded_windows'] = (
                        int(config.get('overloaded_windows', 0) or 0) + 1 if load > sticky_limit else 0
                    )
                    config['underloaded_windows'] = (
                        int(config.get('underloaded_windows', 0) or 0) + 1 if load < low_limit else 0
                    )
                    config['scheduler_window_minute'] = minute
                    item.config = config
                item.updated_at = now
                updated += 1
            await session.commit()
            return updated

    async def set_connection_runtime(
        self,
        db: AsyncSession | None,
        connection_id: str,
        *,
        shard_id: str | None = None,
        account_key: str | None = None,
        assignment_generation: int | None = None,
        last_runtime_node_id: str | None = None,
        last_runtime_at: int | None = None,
    ) -> None:
        """Update only the runtime-assignment fields the caller provides."""
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayConnection, connection_id)
            if item is None:
                return
            for field, value in (
                ('shard_id', shard_id),
                ('account_key', account_key),
                ('assignment_generation', assignment_generation),
                ('last_runtime_node_id', last_runtime_node_id),
                ('last_runtime_at', last_runtime_at),
            ):
                if value is not None:
                    setattr(item, field, value)
            item.updated_at = int(time.time())
            await session.commit()

    async def apply_shard_assignments(
        self,
        assignments: dict[str, str],
        *,
        db: AsyncSession | None = None,
    ) -> list[BotGatewayConnectionModel]:
        """Atomically update assignments and bump fencing generations."""
        if not assignments:
            return []
        async with get_async_db_context(db) as session:
            result = await session.execute(select(BotGatewayConnection).where(BotGatewayConnection.id.in_(assignments)))
            items = list(result.scalars().all())
            now = int(time.time())
            for item in items:
                target = assignments[item.id]
                if item.shard_id == target:
                    continue
                item.shard_id = target
                item.assignment_generation = int(item.assignment_generation or 0) + 1
                item.config = {
                    **(item.config if isinstance(item.config, dict) else {}),
                    'last_shard_move_at': now,
                }
                item.updated_at = now
            await session.commit()
            return [BotGatewayConnectionModel.model_validate(item) for item in items]

    async def upsert_node(
        self,
        node_id: str,
        *,
        advertise_url: str | None = None,
        capabilities: dict[str, Any] | None = None,
        db: AsyncSession | None = None,
    ) -> BotGatewayNodeModel:
        """Register or refresh a gateway runtime node."""
        now = int(time.time())
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayNode, node_id)
            if item is None:
                item = BotGatewayNode(
                    id=node_id,
                    advertise_url=advertise_url,
                    capabilities=capabilities,
                    created_at=now,
                    updated_at=now,
                    last_seen_at=now,
                )
                session.add(item)
            else:
                if advertise_url is not None:
                    item.advertise_url = advertise_url
                if capabilities is not None:
                    item.capabilities = capabilities
                item.last_seen_at = now
                item.updated_at = now
            await session.commit()
            await session.refresh(item)
            return BotGatewayNodeModel.model_validate(item)

    async def touch_node(
        self,
        node_id: str,
        *,
        advertise_url: str | None = None,
        capabilities: dict[str, Any] | None = None,
        db: AsyncSession | None = None,
    ) -> bool:
        """Refresh an existing node's last_seen_at; returns False for unknown nodes."""
        now = int(time.time())
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayNode, node_id)
            if item is None:
                return False
            if advertise_url is not None:
                item.advertise_url = advertise_url
            if capabilities is not None:
                item.capabilities = capabilities
            item.last_seen_at = now
            item.updated_at = now
            await session.commit()
            return True

    async def list_nodes(self, db: AsyncSession | None = None) -> list[BotGatewayNodeModel]:
        async with get_async_db_context(db) as session:
            result = await session.execute(select(BotGatewayNode).order_by(BotGatewayNode.id))
            return [BotGatewayNodeModel.model_validate(item) for item in result.scalars().all()]

    async def list_shards(self, db: AsyncSession | None = None) -> list[BotGatewayShardModel]:
        async with get_async_db_context(db) as session:
            result = await session.execute(select(BotGatewayShard).order_by(BotGatewayShard.id))
            return [BotGatewayShardModel.model_validate(item) for item in result.scalars().all()]

    async def record_control_operation(
        self,
        *,
        kind: str,
        payload: dict[str, Any] | None = None,
        actor_user_id: str | None = None,
        status: str = 'completed',
        db: AsyncSession | None = None,
    ) -> BotGatewayControlOperationModel:
        """Persist one administrative gateway operation (the control-plane audit trail)."""
        now = int(time.time())
        async with get_async_db_context(db) as session:
            item = BotGatewayControlOperation(
                id=str(uuid4()),
                kind=kind,
                payload=payload,
                status=status,
                actor_user_id=actor_user_id,
                created_at=now,
                updated_at=now,
                completed_at=now if status == 'completed' else None,
            )
            session.add(item)
            await session.commit()
            await session.refresh(item)
            return BotGatewayControlOperationModel.model_validate(item)

    async def list_control_operations(
        self,
        *,
        kind: str | None = None,
        since: int | None = None,
        limit: int = 100,
        db: AsyncSession | None = None,
    ) -> list[BotGatewayControlOperationModel]:
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayControlOperation)
            if kind is not None:
                stmt = stmt.where(BotGatewayControlOperation.kind == kind)
            if since is not None:
                stmt = stmt.where(BotGatewayControlOperation.created_at >= since)
            result = await session.execute(
                stmt.order_by(desc(BotGatewayControlOperation.created_at)).limit(max(1, min(limit, 1000)))
            )
            return [BotGatewayControlOperationModel.model_validate(item) for item in result.scalars().all()]

    async def create_binding_code(
        self,
        user_id: str,
        code_hash: str,
        channel: BotGatewayChannel | None,
        expires_at: int,
        db: AsyncSession | None = None,
    ) -> None:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            stale_stmt = update(BotGatewayBindingCode).where(
                BotGatewayBindingCode.user_id == user_id,
                BotGatewayBindingCode.consumed_at.is_(None),
            )
            if channel is None:
                stale_stmt = stale_stmt.where(BotGatewayBindingCode.channel.is_(None))
            else:
                stale_stmt = stale_stmt.where(BotGatewayBindingCode.channel == channel)
            await session.execute(stale_stmt.values(consumed_at=now))
            session.add(
                BotGatewayBindingCode(
                    id=str(uuid4()),
                    user_id=user_id,
                    channel=channel,
                    code_hash=code_hash,
                    expires_at=expires_at,
                    created_at=now,
                )
            )
            await session.commit()

    async def get_enabled_binding(
        self,
        connection_id: str,
        external_user_id: str,
        db: AsyncSession | None = None,
    ) -> BotGatewayBindingModel | None:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(BotGatewayBinding).where(
                    BotGatewayBinding.connection_id == connection_id,
                    BotGatewayBinding.external_user_id == external_user_id,
                    BotGatewayBinding.enabled.is_(True),
                    BotGatewayBinding.blocked.is_(False),
                )
            )
            item = result.scalars().first()
            return BotGatewayBindingModel.model_validate(item) if item else None

    async def ensure_owner_binding(
        self,
        connection_id: str,
        external_user_id: str,
        *,
        display_name: str | None = None,
        db: AsyncSession | None = None,
    ) -> BotGatewayBindingModel | None:
        """Map a personal bot's inbound identity to the RyanAI account that owns it.

        Personal connections do not require a second binding-code ceremony: the
        connection owner is the account whose RyanAI quota, model and chats are
        used.  The identity is still persisted in the normal binding table so
        administrators can audit/block it and duplicate events remain scoped.
        """
        async with get_async_db_context(db) as session:
            connection_stmt = select(BotGatewayConnection).where(BotGatewayConnection.id == connection_id)
            if session.bind and session.bind.dialect.name == 'postgresql':
                connection_stmt = connection_stmt.with_for_update()
            connection = (await session.execute(connection_stmt)).scalars().first()
            if connection is None or not connection.owner_user_id:
                return None
            trusted_external_user_id = str((connection.config or {}).get('trusted_external_user_id') or '').strip()
            if not trusted_external_user_id or trusted_external_user_id != external_user_id:
                return None
            result = await session.execute(
                select(BotGatewayBinding).where(
                    BotGatewayBinding.connection_id == connection_id,
                    BotGatewayBinding.external_user_id == external_user_id,
                )
            )
            item = result.scalars().first()
            now = int(time.time())
            if item is None:
                existing = (
                    (
                        await session.execute(
                            select(BotGatewayBinding).where(
                                BotGatewayBinding.connection_id == connection_id,
                                BotGatewayBinding.enabled.is_(True),
                                BotGatewayBinding.blocked.is_(False),
                            )
                        )
                    )
                    .scalars()
                    .first()
                )
                if existing is not None:
                    return None
                item = BotGatewayBinding(
                    id=str(uuid4()),
                    connection_id=connection_id,
                    user_id=connection.owner_user_id,
                    external_user_id=external_user_id,
                    display_name=display_name,
                    enabled=True,
                    blocked=False,
                    created_at=now,
                    updated_at=now,
                )
                session.add(item)
                await session.flush()
                session.add(
                    BotGatewayBindingHistory(
                        id=str(uuid4()),
                        user_id=connection.owner_user_id,
                        connection_id=connection_id,
                        channel=connection.channel,
                        external_user_id=external_user_id,
                        display_name=display_name,
                        action='auto_bound',
                        actor_user_id=connection.owner_user_id,
                        metadata_json={'source': 'personal_connection'},
                        created_at=now,
                    )
                )
            elif item.user_id != connection.owner_user_id or item.blocked or not item.enabled:
                return None
            else:
                item.updated_at = now
                if display_name:
                    item.display_name = display_name
            await session.commit()
            await session.refresh(item)
            return BotGatewayBindingModel.model_validate(item)

    async def bind_with_code(  # noqa: C901
        self,
        *,
        connection_id: str,
        channel: BotGatewayChannel,
        external_user_id: str,
        display_name: str | None,
        code_hash: str,
        db: AsyncSession | None = None,
    ) -> BotGatewayBindingModel:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            code_stmt = select(BotGatewayBindingCode).where(BotGatewayBindingCode.code_hash == code_hash)
            if session.bind and session.bind.dialect.name == 'postgresql':
                code_stmt = code_stmt.with_for_update()
            code = (await session.execute(code_stmt)).scalars().first()
            if code is None or code.consumed_at is not None or code.expires_at <= now:
                raise BotGatewayBindingError('invalid_or_expired_code')
            if code.channel is not None and code.channel != channel:
                raise BotGatewayBindingError('channel_mismatch')

            target_user = await session.get(User, code.user_id)
            if target_user is None or target_user.role not in {'user', 'admin'}:
                raise BotGatewayBindingError('user_unavailable')

            binding_stmt = select(BotGatewayBinding).where(
                BotGatewayBinding.connection_id == connection_id,
                BotGatewayBinding.external_user_id == external_user_id,
            )
            if session.bind and session.bind.dialect.name == 'postgresql':
                binding_stmt = binding_stmt.with_for_update()
            binding = (await session.execute(binding_stmt)).scalars().first()
            if binding and binding.blocked:
                raise BotGatewayBindingError('identity_blocked')
            if binding and binding.enabled and binding.user_id != code.user_id:
                raise BotGatewayBindingError('identity_already_bound')

            is_new_binding = binding is None
            if binding is None:
                binding = BotGatewayBinding(
                    id=str(uuid4()),
                    connection_id=connection_id,
                    user_id=code.user_id,
                    external_user_id=external_user_id,
                    display_name=display_name,
                    enabled=True,
                    blocked=False,
                    last_seen_at=now,
                    created_at=now,
                    updated_at=now,
                )
                session.add(binding)
                await session.flush()
            else:
                rebind_result = await session.execute(
                    update(BotGatewayBinding)
                    .where(
                        BotGatewayBinding.id == binding.id,
                        BotGatewayBinding.blocked.is_(False),
                    )
                    .values(
                        user_id=code.user_id,
                        display_name=display_name,
                        enabled=True,
                        unbind_requested_at=None,
                        last_seen_at=now,
                        updated_at=now,
                    )
                )
                if rebind_result.rowcount != 1:
                    await session.rollback()
                    raise BotGatewayBindingError('identity_blocked')
                await session.execute(
                    delete(BotGatewayConversation).where(BotGatewayConversation.binding_id == binding.id)
                )

            consume_result = await session.execute(
                update(BotGatewayBindingCode)
                .where(
                    BotGatewayBindingCode.id == code.id,
                    BotGatewayBindingCode.consumed_at.is_(None),
                    BotGatewayBindingCode.expires_at > now,
                )
                .values(consumed_at=now, consumed_by_binding_id=binding.id)
            )
            if consume_result.rowcount != 1:
                await session.rollback()
                raise BotGatewayBindingError('invalid_or_expired_code')
            await session.commit()
            await session.refresh(binding)
            return BotGatewayBindingModel.model_validate(binding).model_copy(update={'is_new_binding': is_new_binding})

    async def list_bindings(
        self,
        *,
        user_id: str | None = None,
        include_disabled: bool = False,
        db: AsyncSession | None = None,
    ) -> list[BotGatewayBindingView]:
        async with get_async_db_context(db) as session:
            stmt = (
                select(BotGatewayBinding, BotGatewayConnection.channel)
                .join(BotGatewayConnection, BotGatewayConnection.id == BotGatewayBinding.connection_id)
                .order_by(desc(BotGatewayBinding.updated_at))
            )
            if user_id is not None:
                stmt = stmt.where(BotGatewayBinding.user_id == user_id)
            if not include_disabled:
                stmt = stmt.where(BotGatewayBinding.enabled.is_(True))
            result = await session.execute(stmt)
            return [
                BotGatewayBindingView(
                    **BotGatewayBindingModel.model_validate(binding).model_dump(),
                    channel=channel,
                    status='blocked' if binding.blocked else ('active' if binding.enabled else 'disabled'),
                )
                for binding, channel in result.all()
            ]

    async def request_unbind(
        self,
        binding_id: str,
        user_id: str,
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayBinding, binding_id)
            if item is None or not item.enabled or item.user_id != user_id:
                return False
            item.unbind_requested_at = int(time.time())
            item.updated_at = item.unbind_requested_at
            await session.commit()
            return True

    async def block_binding(
        self,
        binding_id: str,
        *,
        blocked_by: str,
        db: AsyncSession | None = None,
    ) -> bool:
        """Administratively block an external identity until an admin explicitly changes it."""
        async with get_async_db_context(db) as session:
            now = int(time.time())
            result = await session.execute(
                update(BotGatewayBinding)
                .where(BotGatewayBinding.id == binding_id)
                .values(
                    enabled=False,
                    blocked=True,
                    blocked_at=now,
                    blocked_by=blocked_by,
                    unbind_requested_at=None,
                    updated_at=now,
                )
            )
            if result.rowcount != 1:
                await session.rollback()
                return False
            await session.execute(delete(BotGatewayConversation).where(BotGatewayConversation.binding_id == binding_id))
            await session.commit()
            return True

    async def unblock_binding(
        self,
        binding_id: str,
        db: AsyncSession | None = None,
    ) -> bool:
        """Lift an administrative block without silently restoring a user binding."""
        async with get_async_db_context(db) as session:
            now = int(time.time())
            result = await session.execute(
                update(BotGatewayBinding)
                .where(
                    BotGatewayBinding.id == binding_id,
                    BotGatewayBinding.blocked.is_(True),
                )
                .values(
                    enabled=False,
                    blocked=False,
                    blocked_at=None,
                    blocked_by=None,
                    updated_at=now,
                )
            )
            await session.commit()
            return result.rowcount == 1

    async def unbind(
        self,
        binding_id: str,
        *,
        user_id: str | None = None,
        require_confirmation: bool = False,
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayBinding, binding_id)
            if item is None or (user_id is not None and item.user_id != user_id):
                return False
            now = int(time.time())
            if require_confirmation and (item.unbind_requested_at is None or item.unbind_requested_at < now - 5 * 60):
                return False
            item.enabled = False
            item.unbind_requested_at = None
            item.updated_at = now
            await session.execute(delete(BotGatewayConversation).where(BotGatewayConversation.binding_id == item.id))
            await session.commit()
            return True

    async def touch_binding(
        self,
        binding_id: str,
        display_name: str | None,
        db: AsyncSession | None = None,
    ) -> None:
        async with get_async_db_context(db) as session:
            values: dict[str, Any] = {'last_seen_at': int(time.time()), 'updated_at': int(time.time())}
            if display_name:
                values['display_name'] = display_name
            await session.execute(update(BotGatewayBinding).where(BotGatewayBinding.id == binding_id).values(**values))
            await session.commit()

    async def get_or_create_conversation(
        self,
        *,
        binding: BotGatewayBindingModel,
        conversation_type: BotGatewayConversationType,
        conversation_id: str,
        sender_id: str,
        db: AsyncSession | None = None,
    ) -> BotGatewayConversationModel:
        session_key, normalized_conversation_id, normalized_sender_id = build_bot_gateway_session_key(
            conversation_type,
            conversation_id,
            sender_id,
        )
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayConversation).where(
                BotGatewayConversation.binding_id == binding.id,
                BotGatewayConversation.session_key == session_key,
            )
            item = (await session.execute(stmt)).scalars().first()
            if item:
                return BotGatewayConversationModel.model_validate(item)

            now = int(time.time())
            item = BotGatewayConversation(
                id=str(uuid4()),
                connection_id=binding.connection_id,
                binding_id=binding.id,
                user_id=binding.user_id,
                conversation_type=conversation_type,
                external_conversation_id=normalized_conversation_id,
                external_sender_id=normalized_sender_id,
                session_key=session_key,
                last_event_at=now,
                created_at=now,
                updated_at=now,
            )
            session.add(item)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                item = (await session.execute(stmt)).scalars().first()
                if item is None:
                    raise
            return BotGatewayConversationModel.model_validate(item)

    async def get_conversation(
        self,
        conversation_id: str,
        user_id: str,
        binding_id: str | None = None,
        db: AsyncSession | None = None,
    ):
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayConversation, conversation_id)
            if item is None or item.user_id != user_id or (binding_id is not None and item.binding_id != binding_id):
                return None
            return BotGatewayConversationModel.model_validate(item)

    async def list_conversations(
        self,
        user_id: str,
        limit: int = 20,
        binding_id: str | None = None,
        db: AsyncSession | None = None,
    ):
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayConversation).where(BotGatewayConversation.user_id == user_id)
            if binding_id is not None:
                stmt = stmt.where(BotGatewayConversation.binding_id == binding_id)
            result = await session.execute(
                stmt.order_by(desc(BotGatewayConversation.updated_at)).limit(max(1, min(limit, 100)))
            )
            return [BotGatewayConversationModel.model_validate(item) for item in result.scalars().all()]

    async def update_conversation(
        self,
        conversation_id: str,
        values: dict[str, Any],
        db: AsyncSession | None = None,
    ) -> BotGatewayConversationModel | None:
        allowed = {'chat_id', 'model_id', 'last_event_at'}
        async with get_async_db_context(db) as session:
            item = await session.get(BotGatewayConversation, conversation_id)
            if item is None:
                return None
            for key, value in values.items():
                if key in allowed:
                    setattr(item, key, value)
            item.updated_at = int(time.time())
            await session.commit()
            return BotGatewayConversationModel.model_validate(item)

    async def upsert_group(
        self,
        *,
        connection_id: str,
        external_group_id: str,
        name: str | None = None,
        member_count: int | None = None,
        allowed: bool | None = None,
        updated_by: str | None = None,
        db: AsyncSession | None = None,
    ) -> BotGatewayGroupModel:
        async with get_async_db_context(db) as session:
            stmt = select(BotGatewayGroup).where(
                BotGatewayGroup.connection_id == connection_id,
                BotGatewayGroup.external_group_id == external_group_id,
            )
            item = (await session.execute(stmt)).scalars().first()
            now = int(time.time())
            if item is None:
                item = BotGatewayGroup(
                    id=str(uuid4()),
                    connection_id=connection_id,
                    external_group_id=external_group_id,
                    name=name,
                    allowed=bool(allowed) if allowed is not None else False,
                    member_count=member_count,
                    discovered_at=now,
                    last_seen_at=now,
                    updated_by=updated_by,
                    created_at=now,
                    updated_at=now,
                )
                session.add(item)
                try:
                    await session.commit()
                except IntegrityError:
                    await session.rollback()
                    item = (await session.execute(stmt)).scalars().first()
                    if item is None:
                        raise
            else:
                if name:
                    item.name = name
                if member_count is not None:
                    item.member_count = member_count
                if allowed is not None:
                    item.allowed = allowed
                if updated_by is not None:
                    item.updated_by = updated_by
                item.last_seen_at = now
                item.updated_at = now
                await session.commit()
            return BotGatewayGroupModel.model_validate(item)

    async def list_groups(
        self,
        connection_id: str,
        db: AsyncSession | None = None,
    ) -> list[BotGatewayGroupModel]:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                select(BotGatewayGroup)
                .where(BotGatewayGroup.connection_id == connection_id)
                .order_by(desc(BotGatewayGroup.last_seen_at), BotGatewayGroup.external_group_id)
            )
            return [BotGatewayGroupModel.model_validate(item) for item in result.scalars().all()]

    async def claim_request_nonce(
        self,
        nonce: str,
        *,
        expires_at: int,
        db: AsyncSession | None = None,
    ) -> bool:
        """Atomically consume one authenticated request nonce.

        The primary-key constraint is the concurrency primitive on both SQLite and
        PostgreSQL. A nonce remains reserved beyond the full accepted timestamp
        skew window and is removed later by the bounded retention cleanup.
        """
        async with get_async_db_context(db) as session:
            now = int(time.time())
            await session.execute(
                delete(BotGatewayRequestNonce).where(
                    BotGatewayRequestNonce.nonce == nonce,
                    BotGatewayRequestNonce.expires_at <= now,
                )
            )
            session.add(
                BotGatewayRequestNonce(
                    nonce=nonce,
                    expires_at=max(expires_at, now + 1),
                    created_at=now,
                )
            )
            try:
                await session.commit()
                return True
            except IntegrityError:
                await session.rollback()
                return False

    async def cleanup_expired_records(
        self,
        *,
        now: int | None = None,
        event_retention_seconds: int = BOT_GATEWAY_EVENT_RETENTION_SECONDS,
        force: bool = False,
        db: AsyncSession | None = None,
    ) -> dict[str, int]:
        """Opportunistically bound nonce, event, and binding-code retention."""
        now = now or int(time.time())
        if not force and now < self._next_cleanup_at:
            return {'nonces': 0, 'events': 0, 'binding_codes': 0}
        self._next_cleanup_at = now + BOT_GATEWAY_CLEANUP_INTERVAL_SECONDS

        async with get_async_db_context(db) as session:
            try:
                nonce_result = await session.execute(
                    delete(BotGatewayRequestNonce).where(BotGatewayRequestNonce.expires_at <= now)
                )
                event_result = await session.execute(
                    delete(BotGatewayEvent).where(BotGatewayEvent.updated_at <= now - max(1, event_retention_seconds))
                )
                code_result = await session.execute(
                    delete(BotGatewayBindingCode).where(
                        BotGatewayBindingCode.expires_at <= now - BOT_GATEWAY_BINDING_CODE_RETENTION_SECONDS
                    )
                )
                await session.commit()
                return {
                    'nonces': max(0, nonce_result.rowcount or 0),
                    'events': max(0, event_result.rowcount or 0),
                    'binding_codes': max(0, code_result.rowcount or 0),
                }
            except Exception:
                self._next_cleanup_at = 0
                await session.rollback()
                raise

    async def claim_event(
        self,
        *,
        connection_id: str,
        event_id: str,
        request_hash: str,
        request_nonce: str,
        conversation_type: BotGatewayConversationType,
        external_conversation_id: str,
        external_sender_id: str,
        lease_seconds: int,
        db: AsyncSession | None = None,
    ) -> tuple[BotGatewayEventModel, bool]:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            item = BotGatewayEvent(
                id=str(uuid4()),
                connection_id=connection_id,
                event_id=event_id,
                request_hash=request_hash,
                request_nonce=request_nonce,
                status='processing',
                conversation_type=conversation_type,
                external_conversation_id=external_conversation_id,
                external_sender_id=external_sender_id,
                attempts=1,
                received_at=now,
                updated_at=now,
            )
            session.add(item)
            try:
                await session.commit()
                return BotGatewayEventModel.model_validate(item), True
            except IntegrityError:
                await session.rollback()
                result = await session.execute(
                    select(BotGatewayEvent).where(
                        BotGatewayEvent.connection_id == connection_id,
                        BotGatewayEvent.event_id == event_id,
                    )
                )
                existing = result.scalars().first()
                if existing is None:
                    raise
                if existing.request_hash != request_hash:
                    raise BotGatewayEventConflictError('Event ID was reused with a different payload')
                if existing.status == 'completed':
                    return BotGatewayEventModel.model_validate(existing), False

                lease_cutoff = now - max(1, lease_seconds)
                reclaim_result = await session.execute(
                    update(BotGatewayEvent)
                    .where(
                        BotGatewayEvent.id == existing.id,
                        BotGatewayEvent.request_hash == request_hash,
                        or_(
                            BotGatewayEvent.status == 'failed',
                            and_(
                                BotGatewayEvent.status == 'processing',
                                BotGatewayEvent.updated_at <= lease_cutoff,
                            ),
                        ),
                    )
                    .values(
                        request_nonce=request_nonce,
                        status='processing',
                        error=None,
                        completed_at=None,
                        attempts=BotGatewayEvent.attempts + 1,
                        updated_at=now,
                    )
                )
                await session.commit()
                await session.refresh(existing)
                return BotGatewayEventModel.model_validate(existing), reclaim_result.rowcount == 1

    async def renew_event_lease(
        self,
        event_record_id: str,
        request_nonce: str,
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                update(BotGatewayEvent)
                .where(
                    BotGatewayEvent.id == event_record_id,
                    BotGatewayEvent.status == 'processing',
                    BotGatewayEvent.request_nonce == request_nonce,
                )
                .values(updated_at=int(time.time()))
            )
            await session.commit()
            return result.rowcount == 1

    async def set_event_target(
        self,
        event_record_id: str,
        request_nonce: str,
        *,
        binding_id: str,
        conversation_id: str,
        chat_id: str,
        assistant_message_id: str,
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            result = await session.execute(
                update(BotGatewayEvent)
                .where(
                    BotGatewayEvent.id == event_record_id,
                    BotGatewayEvent.status == 'processing',
                    BotGatewayEvent.request_nonce == request_nonce,
                )
                .values(
                    binding_id=binding_id,
                    conversation_id=conversation_id,
                    chat_id=chat_id,
                    assistant_message_id=assistant_message_id,
                    updated_at=int(time.time()),
                )
            )
            await session.commit()
            return result.rowcount == 1

    async def complete_event(
        self,
        event_record_id: str,
        request_nonce: str,
        response: dict[str, Any],
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            result = await session.execute(
                update(BotGatewayEvent)
                .where(
                    BotGatewayEvent.id == event_record_id,
                    BotGatewayEvent.status == 'processing',
                    BotGatewayEvent.request_nonce == request_nonce,
                )
                .values(status='completed', response=response, error=None, completed_at=now, updated_at=now)
            )
            await session.commit()
            return result.rowcount == 1

    async def fail_event(
        self,
        event_record_id: str,
        request_nonce: str,
        error: str,
        db: AsyncSession | None = None,
    ) -> bool:
        async with get_async_db_context(db) as session:
            now = int(time.time())
            result = await session.execute(
                update(BotGatewayEvent)
                .where(
                    BotGatewayEvent.id == event_record_id,
                    BotGatewayEvent.status == 'processing',
                    BotGatewayEvent.request_nonce == request_nonce,
                )
                .values(status='failed', error=error[:4000], completed_at=now, updated_at=now)
            )
            await session.commit()
            return result.rowcount == 1


BotGateway = BotGatewayTable()
BotGatewayCredentials = BotGatewayCredentialTable()
BotGatewayCheckpoints = BotGatewayCheckpointTable()
