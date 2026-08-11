"""HTTP API for the RyanAI personal WeChat/QQ message gateway."""

from __future__ import annotations

import asyncio
import base64
import binascii
import datetime as dt
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import secrets
import string
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlsplit
from uuid import uuid4

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from open_webui.internal.db import get_async_session
from open_webui.models.bot_gateway import (
    BotGateway,
    BotGatewayBindingError,
    BotGatewayBindingModel,
    BotGatewayChannel,
    BotGatewayConnectionModel,
    BotGatewayConversationModel,
    BotGatewayEventConflictError,
    BotGatewayEventModel,
)
from open_webui.models.chats import ChatForm, Chats
from open_webui.models.config import Config
from open_webui.models.files import Files
from open_webui.models.credits import Credits
from open_webui.models.users import UserModel, Users
from open_webui.utils.auth import create_token, get_admin_user, get_verified_user
from open_webui.utils.misc import get_message_list, get_output_text
from open_webui.utils.models import get_all_models, get_filtered_models
from open_webui.storage.provider import Storage
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import Headers, UploadFile
from starlette.responses import FileResponse, Response

log = logging.getLogger(__name__)

router = APIRouter(prefix='/bot-gateway')
internal_router = APIRouter(prefix='/internal/bot-gateway')

BOT_GATEWAY_BINDING_CODE_TTL = 10 * 60
BOT_GATEWAY_SIGNATURE_MAX_SKEW = 5 * 60
BOT_GATEWAY_MAX_INTERNAL_BODY = 64 * 1024 * 1024
BOT_GATEWAY_MAX_CONTROL_RESPONSE = 2 * 1024 * 1024
BOT_GATEWAY_MAX_REPLY_CHARS = 100_000
BOT_GATEWAY_MEDIA_TTL_SECONDS = 30 * 60
BOT_GATEWAY_HMAC_VERSION = 'v1'
BOT_GATEWAY_EVENT_LEASE_SECONDS = 3 * 60
BOT_GATEWAY_EVENT_HEARTBEAT_SECONDS = 30
BOT_GATEWAY_NONCE_RETENTION_SECONDS = 2 * BOT_GATEWAY_SIGNATURE_MAX_SKEW + 60
BOT_GATEWAY_CHAT_TIMEZONE = dt.timezone(dt.timedelta(hours=8), name='Asia/Shanghai')

_COMMAND_ALIASES = {
    '绑定': 'bind',
    '解绑': 'unbind',
    '新建': 'new',
    '新对话': 'new',
    '模型': 'model',
    '状态': 'status',
    '帮助': 'help',
    '指令': 'help',
    '命令': 'help',
    '积分': 'points',
    '模型列表': 'models',
    '可用模型': 'models',
    '历史': 'history',
    '会话': 'conversation',
}
_COMMAND_NAMES = (
    'bind',
    'unbind',
    'new',
    'model',
    'status',
    'help',
    'points',
    'models',
    'history',
    'conversation',
    *_COMMAND_ALIASES.keys(),
)
_COMMAND_PATTERN = re.compile(
    rf'(?:^|\s)/({"|".join(re.escape(name) for name in sorted(_COMMAND_NAMES, key=len, reverse=True))})(?:\s+(.+?))?\s*$',
    re.IGNORECASE,
)


def _command_guide(title: str = 'Ryan AI 机器人常用指令') -> str:
    return (
        f'【{title}】\n'
        '/帮助 或 /help 查看帮助\n'
        '/状态 或 /status 查看机器人和模型\n'
        '/积分 或 /points 查询积分\n'
        '/模型列表 或 /models 查看可用模型\n'
        '/模型 <序号或名称> 查看或切换模型\n'
        '/历史 或 /history 查看历史对话\n'
        '/会话 <序号> 继续指定对话\n'
        '/新建 或 /new 新建对话\n'
        '/绑定 <绑定码> 绑定账号\n'
        '/解绑 解绑账号\n'
        '使用方法：直接把指令发送给机器人。'
    )


def _binding_messages() -> list[str]:
    return [
        (
            '【隐私协议】\n'
            '你的 Ryan AI 账号已绑定成功。为提供机器人服务，你发送的文字、图片、文件及必要的账号标识会传输至 Ryan AI，'
            '并保存到所绑定账号的对话记录中。请勿发送无权披露的个人信息、账号密码或其他敏感资料。'
            '你可以随时发送 /解绑 停止机器人访问；继续使用即表示你知悉并同意上述处理方式。'
        ),
        (
            '【使用教程】\n'
            '1. 私聊中直接发送文字、图片或文件，机器人会交给 Ryan AI 处理。\n'
            '2. 图片或文件可以附带文字，说明希望 Ryan AI 完成的任务。\n'
            '3. 连续发送默认沿用当前对话；发送 /新建 可开始新对话。\n'
            '4. 发送 /历史 查看最近对话，再发送 /会话 <序号> 继续指定对话。\n'
            '5. 群聊中需要 @机器人，且该群已由管理员允许。'
        ),
        _command_guide('常用指令'),
    ]


@dataclass
class _ConversationLockEntry:
    lock: asyncio.Lock
    references: int = 0


_conversation_locks: dict[str, _ConversationLockEntry] = {}
_background_login_tasks: set[asyncio.Task[None]] = set()


@asynccontextmanager
async def _conversation_lock(key: str):
    entry = _conversation_locks.get(key)
    if entry is None:
        entry = _ConversationLockEntry(lock=asyncio.Lock())
        _conversation_locks[key] = entry
    entry.references += 1
    try:
        async with entry.lock:
            yield
    finally:
        entry.references -= 1
        if entry.references == 0 and _conversation_locks.get(key) is entry:
            _conversation_locks.pop(key, None)


@asynccontextmanager
async def _event_lease(event_record_id: str, request_nonce: str):
    stop = asyncio.Event()

    async def heartbeat() -> None:
        while True:
            try:
                await asyncio.wait_for(stop.wait(), timeout=BOT_GATEWAY_EVENT_HEARTBEAT_SECONDS)
                return
            except TimeoutError:
                pass
            try:
                if not await BotGateway.renew_event_lease(event_record_id, request_nonce):
                    return
            except Exception:
                log.exception('Failed to renew bot gateway event lease %s', event_record_id)

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        yield
    finally:
        stop.set()
        await heartbeat_task


def _env_enabled() -> bool:
    value = os.getenv('BOT_GATEWAY_ENABLED', 'false').strip().lower()
    return value in {'1', 'true', 'yes', 'on'}


def _hmac_secret() -> str:
    secret = os.getenv('BOT_GATEWAY_HMAC_SECRET', '')
    if len(secret) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='BOT_GATEWAY_HMAC_SECRET is not configured',
        )
    return secret


def _public_media_base_url() -> str:
    return os.getenv('BOT_GATEWAY_PUBLIC_BASE_URL', 'https://chat.zhizinan.top').rstrip('/')


def _media_token(file_id: str, user_id: str, expires_at: int) -> str:
    payload = json.dumps(
        {'file_id': file_id, 'user_id': user_id, 'exp': expires_at},
        separators=(',', ':'),
    ).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip('=')
    signature = hmac.new(_hmac_secret().encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return f'{encoded}.{signature}'


def _media_url(file_id: str, user_id: str) -> str:
    expires_at = int(time.time()) + BOT_GATEWAY_MEDIA_TTL_SECONDS
    return f'{_public_media_base_url()}/api/internal/bot-gateway/media/{_media_token(file_id, user_id, expires_at)}'


def _generated_image_urls(message: dict[str, Any], user_id: str) -> list[str]:
    urls: list[str] = []
    for item in message.get('files') or []:
        if not isinstance(item, dict):
            continue
        content_type = str(item.get('type') or item.get('content_type') or '').lower()
        file_id = item.get('id') or item.get('file_id')
        raw_url = str(item.get('url') or '')
        for marker in ('/api/v1/files/', '/api/files/'):
            if not file_id and marker in raw_url:
                file_id = raw_url.split(marker, 1)[1].split('/', 1)[0]
        if file_id and (content_type.startswith('image/') or item.get('type') == 'image'):
            urls.append(_media_url(str(file_id), user_id))
    return list(dict.fromkeys(urls))


def _decode_media_token(token: str) -> dict[str, Any] | None:
    try:
        encoded, signature = token.rsplit('.', 1)
        expected = hmac.new(_hmac_secret().encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        padded = encoded + '=' * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode())
        if not isinstance(payload, dict) or int(payload.get('exp', 0)) < int(time.time()):
            return None
        if not payload.get('file_id') or not payload.get('user_id'):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeError, binascii.Error):
        return None


def format_bot_chat_title(channel: BotGatewayChannel, created_at: int, sequence: int) -> str:
    label = '微信' if channel == 'wechat' else 'QQ'
    date = dt.datetime.fromtimestamp(created_at, BOT_GATEWAY_CHAT_TIMEZONE).strftime('%Y%m%d')
    return f'🤖{label}-{date}-{sequence:03d}'


def _history_chat_title(chat: Any, created_at: int) -> str:
    title = getattr(chat, 'title', None)
    chat_data = getattr(chat, 'chat', None)
    if not title and isinstance(chat_data, dict):
        title = chat_data.get('title')
    if isinstance(title, str) and title.strip():
        return title.strip()
    date = dt.datetime.fromtimestamp(created_at, BOT_GATEWAY_CHAT_TIMEZONE).strftime('%Y-%m-%d')
    return f'Ryan AI 对话 {date}'


async def _conversation_history_entries(
    user_id: str,
    binding_id: str,
    limit: int = 20,
) -> list[tuple[BotGatewayConversationModel, str]]:
    conversations = await BotGateway.list_conversations(user_id, limit=limit, binding_id=binding_id)
    entries: list[tuple[BotGatewayConversationModel, str]] = []
    for item in conversations:
        if not item.chat_id:
            continue
        chat = await Chats.get_chat_by_id_and_user_id(item.chat_id, user_id)
        entries.append((item, _history_chat_title(chat, item.created_at)))
    return entries


def _bot_chat_day_bounds(created_at: int) -> tuple[int, int]:
    local_time = dt.datetime.fromtimestamp(created_at, BOT_GATEWAY_CHAT_TIMEZONE)
    day_start = local_time.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day_start.timestamp()), int((day_start + dt.timedelta(days=1)).timestamp())


def _require_enabled() -> None:
    return None


async def _gateway_policy() -> dict[str, Any]:
    value = await Config.get('bot_gateway.settings', {})
    value = value if isinstance(value, dict) else {}
    return {
        'enabled': bool(value.get('enabled', False)),
        'qq_enabled': bool(value.get('qq_enabled', False)),
        'wechat_enabled': bool(value.get('wechat_enabled', False)),
        'recommended_model_id': value.get('recommended_model_id') or None,
    }


async def _require_channel_enabled(channel: BotGatewayChannel) -> dict[str, Any]:
    policy = await _gateway_policy()
    if not policy['enabled'] or not policy[f'{channel}_enabled']:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f'{channel} bot is disabled by the administrator',
        )
    return policy


def _internal_url() -> str:
    value = os.getenv('BOT_GATEWAY_INTERNAL_URL', '').strip().rstrip('/')
    parsed = urlsplit(value)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='BOT_GATEWAY_INTERNAL_URL is not configured',
        )
    return value


def canonical_bot_gateway_request(
    method: str,
    path_with_query: str,
    timestamp: str,
    nonce: str,
    content_sha256: str,
) -> str:
    return '\n'.join(
        [
            BOT_GATEWAY_HMAC_VERSION,
            timestamp,
            nonce,
            method.upper(),
            path_with_query,
            content_sha256,
        ]
    )


def sign_bot_gateway_request(
    secret: str,
    method: str,
    path_with_query: str,
    body: bytes,
    *,
    timestamp: str | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    timestamp = timestamp or str(int(time.time()))
    nonce = nonce or str(uuid4())
    content_sha256 = hashlib.sha256(body).hexdigest()
    canonical = canonical_bot_gateway_request(method, path_with_query, timestamp, nonce, content_sha256)
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        'x-ryanai-timestamp': timestamp,
        'x-ryanai-nonce': nonce,
        'x-ryanai-content-sha256': content_sha256,
        'x-ryanai-signature': f'{BOT_GATEWAY_HMAC_VERSION}={signature}',
    }


def verify_bot_gateway_signature(
    secret: str,
    method: str,
    path_with_query: str,
    body: bytes,
    headers: Headers | dict[str, str],
    *,
    now: int | None = None,
) -> tuple[str, str]:
    timestamp = headers.get('x-ryanai-timestamp')
    nonce = headers.get('x-ryanai-nonce')
    content_sha256 = headers.get('x-ryanai-content-sha256')
    signature = headers.get('x-ryanai-signature')
    if not timestamp or not nonce or not content_sha256 or not signature:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing bot gateway signature')
    if not re.fullmatch(r'[A-Za-z0-9._:-]{16,128}', nonce):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid bot gateway nonce')
    try:
        timestamp_value = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid bot gateway timestamp') from exc
    if abs((now or int(time.time())) - timestamp_value) > BOT_GATEWAY_SIGNATURE_MAX_SKEW:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Stale bot gateway signature')

    actual_hash = hashlib.sha256(body).hexdigest()
    if not hmac.compare_digest(actual_hash, content_sha256.lower()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Bot gateway content hash mismatch')
    canonical = canonical_bot_gateway_request(method, path_with_query, timestamp, nonce, actual_hash)
    expected = f'{BOT_GATEWAY_HMAC_VERSION}={hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()}'
    if not hmac.compare_digest(expected, signature.lower()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid bot gateway signature')
    return nonce, actual_hash


async def _verify_internal_request(request: Request) -> tuple[str, str, bytes]:
    _require_enabled()
    content_length = request.headers.get('content-length')
    if content_length and content_length.isdigit() and int(content_length) > BOT_GATEWAY_MAX_INTERNAL_BODY:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail='Bot gateway event is too large',
        )
    body = await request.body()
    if len(body) > BOT_GATEWAY_MAX_INTERNAL_BODY:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail='Bot gateway event is too large',
        )
    path_with_query = request.url.path
    if request.url.query:
        path_with_query += f'?{request.url.query}'
    nonce, body_hash = verify_bot_gateway_signature(
        _hmac_secret(),
        request.method,
        path_with_query,
        body,
        request.headers,
    )
    return nonce, body_hash, body


async def _sidecar_request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    _require_enabled()
    secret = _hmac_secret()
    base_url = _internal_url()
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode() if payload is not None else b''
    url = f'{base_url}{path}'
    parsed = urlsplit(url)
    path_with_query = parsed.path + (f'?{parsed.query}' if parsed.query else '')
    headers = {
        **sign_bot_gateway_request(secret, method, path_with_query, body),
        'accept': 'application/json',
    }
    if payload is not None:
        headers['content-type'] = 'application/json'
    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(method, url, headers=headers, data=body or None) as response:
                raw = await response.content.read(BOT_GATEWAY_MAX_CONTROL_RESPONSE + 1)
                if len(raw) > BOT_GATEWAY_MAX_CONTROL_RESPONSE:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail='Bot gateway response is too large',
                    )
                if response.status == status.HTTP_204_NO_CONTENT:
                    return None
                try:
                    data = json.loads(raw.decode()) if raw else {}
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail='Bot gateway returned invalid JSON',
                    ) from exc
                if response.status >= 400:
                    detail = data.get('detail') or data.get('message') if isinstance(data, dict) else None
                    raise HTTPException(
                        status_code=response.status if response.status < 500 else status.HTTP_502_BAD_GATEWAY,
                        detail=detail or 'Bot gateway control request failed',
                    )
                return data
    except HTTPException:
        raise
    except (aiohttp.ClientError, TimeoutError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail='Bot gateway sidecar is unavailable',
        ) from exc


class ConnectionUpdateForm(BaseModel):
    enabled: bool
    model_config = ConfigDict(extra='forbid')


class CredentialsForm(BaseModel):
    app_id: str = Field(min_length=1, max_length=512)
    app_secret: str = Field(min_length=1, max_length=4096)
    model_config = ConfigDict(extra='forbid')


class GroupUpdateForm(BaseModel):
    allowed: bool
    model_config = ConfigDict(extra='forbid')


class BindingCodeForm(BaseModel):
    channel: BotGatewayChannel | None = None
    model_config = ConfigDict(extra='forbid')


class InboundConversation(BaseModel):
    type: Literal['private', 'group']
    id: str = Field(min_length=1, max_length=512)
    name: str | None = Field(default=None, max_length=512)
    model_config = ConfigDict(extra='forbid')


class InboundSender(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    name: str | None = Field(default=None, max_length=512)
    model_config = ConfigDict(extra='forbid')


class InboundMessage(BaseModel):
    text: str = Field(default='', max_length=50_000)
    mentions_bot: bool = False
    model_config = ConfigDict(extra='forbid')


class InboundAttachment(BaseModel):
    field_name: str = Field(min_length=1, max_length=128)
    id: str = Field(min_length=1, max_length=512)
    file_name: str = Field(min_length=1, max_length=512)
    content_type: str = Field(min_length=1, max_length=200)
    size: int = Field(ge=0, le=50 * 1024 * 1024)
    sha256: str
    model_config = ConfigDict(extra='forbid')

    @field_validator('field_name')
    @classmethod
    def validate_field_name(cls, value: str) -> str:
        if not re.fullmatch(r'attachment_[0-9]+', value):
            raise ValueError('invalid attachment field name')
        return value

    @field_validator('sha256')
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not re.fullmatch(r'[A-Fa-f0-9]{64}', value):
            raise ValueError('invalid attachment hash')
        return value.lower()


class InboundEvent(BaseModel):
    version: Literal['1.0']
    event_id: str = Field(min_length=1, max_length=256)
    occurred_at: dt.datetime
    channel: BotGatewayChannel
    connection_id: str = Field(min_length=1, max_length=512)
    conversation: InboundConversation
    sender: InboundSender
    message: InboundMessage
    attachments: list[InboundAttachment] = Field(default_factory=list, max_length=20)
    model_config = ConfigDict(extra='forbid')


def parse_bot_gateway_command(text: str) -> tuple[str, str | None] | None:
    match = _COMMAND_PATTERN.search(text.strip())
    if not match:
        return None
    raw_command = match.group(1).lower()
    command = _COMMAND_ALIASES.get(raw_command, raw_command)
    argument = match.group(2).strip() if match.group(2) else None
    if command == 'unbind' and argument == '确认':
        argument = 'confirm'
    elif command == 'model' and argument == '默认':
        argument = 'default'
    return command, argument


def _normalize_binding_code(value: str) -> str:
    return ''.join(character for character in value.upper() if character in string.ascii_uppercase + string.digits)


def hash_bot_gateway_binding_code(value: str, secret: str | None = None) -> str:
    normalized = _normalize_binding_code(value)
    key = (secret or _hmac_secret()).encode()
    return hmac.new(key, normalized.encode(), hashlib.sha256).hexdigest()


def _new_binding_code() -> str:
    alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    raw = ''.join(secrets.choice(alphabet) for _ in range(10))
    return f'{raw[:5]}-{raw[5:]}'


def _remote_items(payload: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        values = payload.get(key) or payload.get('items') or []
        return [item for item in values if isinstance(item, dict)] if isinstance(values, list) else []
    return []


def _remote_object(payload: Any, key: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    nested = payload.get(key)
    return nested if isinstance(nested, dict) else payload


def _remote_credentials_configured(remote: dict[str, Any], fallback: bool) -> bool:
    if 'credentials_configured' in remote:
        return bool(remote['credentials_configured'])
    if 'configured' in remote:
        return bool(remote['configured'])
    status_value = str(remote.get('status') or '').lower()
    account_value = (
        remote.get('account_id')
        or remote.get('accountLabel')
        or remote.get('account_label')
    )
    if account_value and status_value in {'connected', 'degraded', 'unavailable'}:
        return True
    return fallback


def _connection_response(
    connection: BotGatewayConnectionModel,
    remote: dict[str, Any] | None = None,
    owner: UserModel | None = None,
) -> dict:
    remote = remote or {}
    configured = _remote_credentials_configured(remote, connection.credentials_configured)
    return {
        'id': connection.id,
        'channel': connection.channel,
        'enabled': bool(remote.get('enabled', connection.enabled)),
        'status': str(remote.get('status') or connection.status),
        'configured': configured,
        'credentials_configured': configured,
        'account_id': remote.get('account_id', connection.account_id),
        'account_name': remote.get(
            'account_name',
            remote.get('accountLabel', remote.get('account_label', connection.account_name)),
        ),
        'last_error': remote.get('last_error', remote.get('detail', connection.last_error)),
        'owner_user_id': connection.owner_user_id,
        'owner_name': owner.name if owner else None,
        'owner_username': owner.username if owner else None,
        'owner_email': owner.email if owner else None,
        'updated_at': remote.get('updated_at', remote.get('updatedAt', connection.updated_at)),
    }


async def _sync_connection(connection: BotGatewayConnectionModel, remote: dict[str, Any]) -> BotGatewayConnectionModel:
    values: dict[str, Any] = {}
    mappings = {
        'enabled': 'enabled',
        'status': 'status',
        'credentials_configured': 'credentials_configured',
        'configured': 'credentials_configured',
        'account_id': 'account_id',
        'account_name': 'account_name',
        'last_error': 'last_error',
    }
    for source, target in mappings.items():
        if source in remote:
            values[target] = remote[source]
    if 'accountLabel' in remote or 'account_label' in remote:
        values['account_name'] = remote.get('accountLabel', remote.get('account_label'))
    if 'credentials_configured' not in values:
        configured = _remote_credentials_configured(remote, connection.credentials_configured)
        if configured != connection.credentials_configured:
            values['credentials_configured'] = configured
    if 'detail' in remote and 'last_error' not in remote:
        values['last_error'] = remote.get('detail')
    return await BotGateway.update_connection(connection.id, values) if values else connection


@router.get('/admin/connections')
async def get_connections(
    user=Depends(get_admin_user),
    db: AsyncSession = Depends(get_async_session),
):
    # The admin view is backed by RyanAI's connection registry, not by the
    # sidecar's fixed channel defaults.  Legacy rows remain visible for
    # migration compatibility, while user-owned rows are listed as-is.
    connections = await BotGateway.list_connections()
    owners = {
        owner_id: await Users.get_user_by_id(owner_id, db=db)
        for owner_id in {item.owner_user_id for item in connections if item.owner_user_id}
    }
    if not _env_enabled():
        return [
            _connection_response(connection, owner=owners.get(connection.owner_user_id))
            for connection in connections
        ]
    try:
        payload = await _sidecar_request('GET', '/v1/connections')
    except HTTPException:
        log.warning('Bot gateway sidecar is unavailable while listing admin connections')
        return [
            _connection_response(connection, owner=owners.get(connection.owner_user_id))
            for connection in connections
        ]
    remote_by_id = {
        str(item.get('id') or item.get('connection_id')): item for item in _remote_items(payload, 'connections')
    }
    response = []
    for connection in connections:
        remote = remote_by_id.get(connection.id, {})
        connection = await _sync_connection(connection, remote)
        response.append(
            _connection_response(
                connection,
                remote,
                owner=owners.get(connection.owner_user_id),
            )
        )
    return response


async def _get_connection_or_404(connection_id: str) -> BotGatewayConnectionModel:
    connection = await BotGateway.get_connection(connection_id)
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Bot connection not found')
    return connection


@router.patch('/admin/connections/{connection_id}')
async def update_connection(connection_id: str, form_data: ConnectionUpdateForm, user=Depends(get_admin_user)):
    connection = await _get_connection_or_404(connection_id)
    remote = await _sidecar_request(
        'PATCH',
        f'/v1/connections/{quote(connection_id, safe="")}',
        form_data.model_dump(),
    )
    remote = _remote_object(remote, 'connection')
    connection = await BotGateway.update_connection(connection.id, {'enabled': form_data.enabled}) or connection
    connection = await _sync_connection(connection, remote)
    return _connection_response(connection, remote)


@router.put('/admin/connections/{connection_id}/credentials')
async def set_credentials(connection_id: str, form_data: CredentialsForm, user=Depends(get_admin_user)):
    connection = await _get_connection_or_404(connection_id)
    remote = await _sidecar_request(
        'PUT',
        f'/v1/connections/{quote(connection_id, safe="")}/credentials',
        form_data.model_dump(),
    )
    remote = remote if isinstance(remote, dict) else {}
    connection = await BotGateway.update_connection(connection.id, {'credentials_configured': True}) or connection
    connection = await _sync_connection(connection, remote)
    return _connection_response(connection, remote)


def _qr_code_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value
    if not isinstance(value, dict):
        return None
    for key in (
        'data_url',
        'dataUrl',
        'qr_code',
        'qrCode',
        'qrcode',
        'qrcode_url',
        'qrcodeUrl',
        'qrcode_img_content',
        'url',
        'text',
        'content',
        'value',
    ):
        result = _qr_code_value(value.get(key))
        if result:
            return result
    return None


def _login_response(payload: Any) -> dict:
    value = payload if isinstance(payload, dict) else {}
    connection = value.get('connection') if isinstance(value.get('connection'), dict) else value
    qr_code = value.get('qr_code') or value.get('qrCode')
    qr_code_value = _qr_code_value(qr_code) or _qr_code_value(
        value.get('qr_code_data_url') or value.get('dataUrl') or value.get('qrcodeUrl')
    )
    expires_at = (
        qr_code.get('expires_at') or qr_code.get('expiresAt')
        if isinstance(qr_code, dict)
        else None
    )
    return {
        'state': str(
            connection.get('status')
            or connection.get('state')
            or value.get('status')
            or value.get('state')
            or 'pending'
        ),
        'qr_code': qr_code_value or value.get('qr_code_data_url') or value.get('dataUrl'),
        'expires_at': expires_at or value.get('expires_at') or value.get('expiresAt'),
        'message': connection.get('detail') or value.get('message') or value.get('detail'),
    }


@router.post('/admin/connections/{connection_id}/login')
async def begin_login(connection_id: str, user=Depends(get_admin_user)):
    await _get_connection_or_404(connection_id)
    return _login_response(await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/login'))


@router.get('/admin/connections/{connection_id}/login')
async def get_login(connection_id: str, user=Depends(get_admin_user)):
    await _get_connection_or_404(connection_id)
    return _login_response(await _sidecar_request('GET', f'/v1/connections/{quote(connection_id, safe="")}/login'))


@router.post('/admin/connections/{connection_id}/reconnect')
async def reconnect(connection_id: str, user=Depends(get_admin_user)):
    connection = await _get_connection_or_404(connection_id)
    remote = await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/reconnect')
    remote = _remote_object(remote, 'connection')
    connection = await _sync_connection(connection, remote)
    return _connection_response(connection, remote)


@router.post('/admin/connections/{connection_id}/logout', status_code=status.HTTP_204_NO_CONTENT)
async def logout(connection_id: str, user=Depends(get_admin_user)):
    connection = await _get_connection_or_404(connection_id)
    remote = await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/logout')
    connection = await _sync_connection(connection, _remote_object(remote, 'connection'))
    await BotGateway.update_connection(
        connection.id,
        {
            'status': 'logged_out',
            'credentials_configured': False,
            'account_id': None,
            'account_name': None,
            'last_error': None,
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _group_remote_values(item: dict[str, Any]) -> tuple[str, str | None, int | None, int | None]:
    group_id = str(item.get('id') or item.get('group_id') or item.get('groupId') or '')
    name = item.get('name') or item.get('group_name')
    member_count = item.get('member_count')
    discovered = item.get('discovered_at') or item.get('last_seen_at') or item.get('lastSeenAt')
    if isinstance(discovered, str):
        try:
            discovered = int(dt.datetime.fromisoformat(discovered.replace('Z', '+00:00')).timestamp())
        except ValueError:
            discovered = None
    return group_id, str(name) if name is not None else None, member_count, discovered


async def _merge_groups(connection_id: str, payload: Any) -> list[dict]:
    for item in _remote_items(payload, 'groups'):
        group_id, name, member_count, _ = _group_remote_values(item)
        if group_id:
            await BotGateway.upsert_group(
                connection_id=connection_id,
                external_group_id=group_id,
                name=name,
                member_count=member_count if isinstance(member_count, int) else None,
            )
    groups = await BotGateway.list_groups(connection_id)
    return [
        {
            'id': group.external_group_id,
            'name': group.name or group.external_group_id,
            'allowed': group.allowed,
            'member_count': group.member_count,
            'discovered_at': group.discovered_at or group.last_seen_at,
        }
        for group in groups
    ]


@router.get('/admin/connections/{connection_id}/groups')
async def get_groups(connection_id: str, user=Depends(get_admin_user)):
    await _get_connection_or_404(connection_id)
    payload = await _sidecar_request('GET', f'/v1/connections/{quote(connection_id, safe="")}/groups')
    return await _merge_groups(connection_id, payload)


@router.post('/admin/connections/{connection_id}/groups/discover')
async def discover_groups(connection_id: str, user=Depends(get_admin_user)):
    await _get_connection_or_404(connection_id)
    payload = await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/groups/discover')
    return await _merge_groups(connection_id, payload)


@router.patch('/admin/connections/{connection_id}/groups/{group_id}')
async def update_group(
    connection_id: str,
    group_id: str,
    form_data: GroupUpdateForm,
    user=Depends(get_admin_user),
):
    await _get_connection_or_404(connection_id)
    remote = await _sidecar_request(
        'PATCH',
        f'/v1/connections/{quote(connection_id, safe="")}/groups/{quote(group_id, safe="")}',
        {'enabled': form_data.allowed},
    )
    remote = _remote_object(remote, 'group')
    _, name, member_count, _ = _group_remote_values({**remote, 'id': group_id})
    group = await BotGateway.upsert_group(
        connection_id=connection_id,
        external_group_id=group_id,
        name=name,
        member_count=member_count if isinstance(member_count, int) else None,
        allowed=form_data.allowed,
        updated_by=user.id,
    )
    return {
        'id': group.external_group_id,
        'name': group.name or group.external_group_id,
        'allowed': group.allowed,
        'member_count': group.member_count,
        'discovered_at': group.discovered_at or group.last_seen_at,
    }


@router.post('/bindings/code')
async def create_binding_code(form_data: BindingCodeForm, user=Depends(get_verified_user)):
    _require_enabled()
    code = _new_binding_code()
    expires_at = int(time.time()) + BOT_GATEWAY_BINDING_CODE_TTL
    await BotGateway.create_binding_code(
        user.id,
        hash_bot_gateway_binding_code(code),
        form_data.channel,
        expires_at,
    )
    return {
        'code': code,
        'channel': form_data.channel,
        'expires_at': expires_at,
        'expires_in': BOT_GATEWAY_BINDING_CODE_TTL,
    }


class UserBotForm(BaseModel):
    channel: BotGatewayChannel
    enabled: bool = True


class UserBotCredentialsForm(BaseModel):
    app_id: str | None = Field(default=None, max_length=512)
    app_secret: str | None = Field(default=None, max_length=4096)


class UserBotModelForm(BaseModel):
    model_id: str | None = Field(
        default=None,
        max_length=512,
        validation_alias=AliasChoices('model_id', 'default_model_id'),
    )


class AdminBotSettingsForm(BaseModel):
    enabled: bool | None = None
    qq_enabled: bool | None = None
    wechat_enabled: bool | None = None
    recommended_model_id: str | None = Field(default=None, max_length=512)


@router.get('/settings')
async def get_bot_settings(user=Depends(get_verified_user)):
    setting = await BotGateway.get_user_setting(user.id)
    policy = await _gateway_policy()
    return {
        'default_model_id': setting.default_model_id,
        'admin_recommended_model_id': policy['recommended_model_id'],
        'available': policy['enabled'],
        'qq_enabled': policy['qq_enabled'],
        'wechat_enabled': policy['wechat_enabled'],
        'bindings': [item.model_dump() for item in await BotGateway.list_bindings(user_id=user.id)],
    }


@router.get('/user/settings')
async def get_user_bot_settings(user=Depends(get_verified_user)):
    return await get_bot_settings(user)


@router.get('/admin/settings')
async def get_admin_bot_settings(user=Depends(get_admin_user)):
    return await _gateway_policy()


@router.patch('/admin/settings')
async def patch_admin_bot_settings(
    form_data: AdminBotSettingsForm,
    request: Request,
    user=Depends(get_admin_user),
):
    policy = await _gateway_policy()
    updates = policy.copy()
    for field in ('enabled', 'qq_enabled', 'wechat_enabled'):
        value = getattr(form_data, field)
        if value is not None:
            updates[field] = value
    if form_data.recommended_model_id:
        available = {item['id'] for item in await _accessible_models(request, user)}
        if form_data.recommended_model_id not in available:
            raise HTTPException(status_code=400, detail='Recommended model is not available')
    if 'recommended_model_id' in form_data.model_fields_set:
        updates['recommended_model_id'] = form_data.recommended_model_id
    await Config.upsert({'bot_gateway.settings': updates})
    return await _gateway_policy()


@router.get('/admin/audit')
async def get_admin_bot_audit(user=Depends(get_admin_user)):
    records = await BotGateway.list_binding_history(limit=200)
    return [
        {
            'id': item.id,
            'action': item.action,
            'channel': item.channel,
            'user_id': item.user_id,
            'account_id': item.external_user_id,
            'actor_id': item.actor_user_id,
            'created_at': item.created_at,
            'detail': item.metadata or item.display_name,
        }
        for item in records
    ]


@router.put('/settings/model')
async def set_bot_model(form_data: UserBotModelForm, request: Request, user=Depends(get_verified_user)):
    if form_data.model_id and form_data.model_id not in {item['id'] for item in await _accessible_models(request, user)}:
        raise HTTPException(status_code=400, detail='Model is not available to this user')
    return (await BotGateway.update_user_setting(user.id, form_data.model_id)).model_dump()


@router.patch('/user/settings')
async def patch_user_bot_settings(form_data: UserBotModelForm, request: Request, user=Depends(get_verified_user)):
    return await set_bot_model(form_data, request, user)


async def _user_connection_or_create(user_id: str, channel: BotGatewayChannel) -> BotGatewayConnectionModel:
    policy = await _require_channel_enabled(channel)
    return await BotGateway.ensure_user_connection(user_id, channel, enabled=policy['enabled'])


async def _ensure_sidecar_connection(connection: BotGatewayConnectionModel) -> None:
    """Create the matching dynamic sidecar runtime before credentials/login."""
    try:
        await _sidecar_request(
            'POST',
            '/v1/connections',
            {
                'channel': connection.channel,
                'owner_user_id': connection.owner_user_id,
                'connection_id': connection.id,
                'enabled': connection.enabled,
            },
        )
    except HTTPException as exc:
        # The sidecar is idempotent at the application layer only for the
        # backend-created ID. A duplicate means the runtime already exists.
        if exc.status_code != status.HTTP_409_CONFLICT:
            raise


async def _finish_background_login(connection_id: str, expected_updated_at: int) -> None:
    try:
        remote = await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/login')
        current = await BotGateway.get_connection(connection_id)
        if current is None or not current.credentials_configured or current.updated_at != expected_updated_at:
            return
        remote_connection = _remote_object(remote, 'connection')
        if remote_connection:
            await _sync_connection(current, remote_connection)
    except Exception:
        log.exception('QQ login could not start in the background for user bot %s', connection_id)
        current = await BotGateway.get_connection(connection_id)
        if current is not None and current.credentials_configured and current.updated_at == expected_updated_at:
            await BotGateway.update_connection(
                connection_id,
                {'status': 'degraded', 'last_error': 'Bot gateway login could not start'},
            )


def _schedule_background_login(connection_id: str, expected_updated_at: int) -> None:
    task = asyncio.create_task(_finish_background_login(connection_id, expected_updated_at))
    _background_login_tasks.add(task)
    task.add_done_callback(_background_login_tasks.discard)


def _user_connection_response(connection: BotGatewayConnectionModel) -> dict[str, Any]:
    return _connection_response(connection)


@router.get('/user/connections')
async def get_user_bot_connections(user=Depends(get_verified_user)):
    policy = await _gateway_policy()
    result = []
    for channel in ('qq', 'wechat'):
        connection = await BotGateway.get_user_connection(user.id, channel)
        if connection is not None:
            try:
                payload = await _sidecar_request('GET', f'/v1/connections?owner_user_id={quote(user.id, safe="")}')
                remote = next(
                    (item for item in _remote_items(payload, 'connections') if item.get('id') == connection.id),
                    None,
                )
                if remote:
                    connection = await _sync_connection(connection, remote)
            except HTTPException:
                log.debug('Unable to refresh sidecar status for %s', connection.id)
            result.append(_user_connection_response(connection))
    return result


@router.post('/user/connections/{channel}')
async def create_user_bot_alias(channel: BotGatewayChannel, user=Depends(get_verified_user)):
    connection = await _user_connection_or_create(user.id, channel)
    await _ensure_sidecar_connection(connection)
    return _user_connection_response(connection)


@router.put('/user/connections/qq/credentials')
async def set_user_qq_credentials(form_data: UserBotCredentialsForm, user=Depends(get_verified_user)):
    connection = await _user_connection_or_create(user.id, 'qq')
    if not form_data.app_id or not form_data.app_secret:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='QQ AppID and AppSecret are required')
    await _ensure_sidecar_connection(connection)
    await _sidecar_request(
        'PUT', f'/v1/connections/{quote(connection.id, safe="")}/credentials',
        {'app_id': form_data.app_id, 'app_secret': form_data.app_secret},
    )
    connection = await BotGateway.update_connection(connection.id, {'credentials_configured': True}) or connection
    _schedule_background_login(connection.id, connection.updated_at)
    await BotGateway.add_binding_history(channel='qq', action='credentials_saved', user_id=user.id, connection_id=connection.id, actor_user_id=user.id)
    return _user_connection_response(connection)


@router.post('/user/connections/wechat/login')
async def begin_user_wechat_login(user=Depends(get_verified_user)):
    connection = await _user_connection_or_create(user.id, 'wechat')
    await _ensure_sidecar_connection(connection)
    payload = await _sidecar_request('POST', f'/v1/connections/{quote(connection.id, safe="")}/login')
    await BotGateway.add_binding_history(channel='wechat', action='login_started', user_id=user.id, connection_id=connection.id, actor_user_id=user.id)
    return _login_response(payload)


@router.get('/user/connections/wechat/login')
async def get_user_wechat_login(user=Depends(get_verified_user)):
    connection = await BotGateway.get_user_connection(user.id, 'wechat')
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='WeChat bot is not configured')
    payload = await _sidecar_request('GET', f'/v1/connections/{quote(connection.id, safe="")}/login')
    remote_connection = _remote_object(payload, 'connection')
    if remote_connection:
        await _sync_connection(connection, remote_connection)
    return _login_response(payload)


@router.post('/user/connections/{channel}/logout', status_code=status.HTTP_204_NO_CONTENT)
async def logout_user_bot(channel: BotGatewayChannel, user=Depends(get_verified_user)):
    connection = await BotGateway.get_user_connection(user.id, channel)
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Bot connection not found')
    await _sidecar_request('POST', f'/v1/connections/{quote(connection.id, safe="")}/logout')
    await BotGateway.update_connection(connection.id, {'status': 'logged_out', 'credentials_configured': False, 'account_id': None, 'account_name': None, 'last_error': None})
    await BotGateway.add_binding_history(channel=channel, action='logged_out', user_id=user.id, connection_id=connection.id, actor_user_id=user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/settings/bots')
async def create_user_bot(form_data: UserBotForm, user=Depends(get_verified_user)):
    connection = await BotGateway.ensure_user_connection(user.id, form_data.channel, enabled=form_data.enabled)
    await BotGateway.add_binding_history(channel=form_data.channel, action='created', user_id=user.id, connection_id=connection.id, actor_user_id=user.id)
    remote = await _sidecar_request('POST', '/v1/connections', {'channel': form_data.channel, 'owner_user_id': user.id, 'connection_id': connection.id, 'enabled': form_data.enabled})
    remote_connection = _remote_object(remote, 'connection')
    if remote_connection:
        await BotGateway.update_connection(connection.id, {'status': remote_connection.get('status', connection.status)})
    return _connection_response(await BotGateway.get_connection(connection.id) or connection)


@router.put('/settings/bots/{connection_id}/credentials')
async def set_user_bot_credentials(connection_id: str, form_data: UserBotCredentialsForm, user=Depends(get_verified_user)):
    connection = await _get_connection_or_404(connection_id)
    if connection.owner_user_id != user.id or connection.channel != 'qq' or not form_data.app_id or not form_data.app_secret:
        raise HTTPException(status_code=404, detail='QQ bot connection not found')
    await _sidecar_request('PUT', f'/v1/connections/{quote(connection_id, safe="")}/credentials', form_data.model_dump())
    return _connection_response(await BotGateway.update_connection(connection_id, {'credentials_configured': True}) or connection)


@router.post('/settings/bots/{connection_id}/login')
async def login_user_bot(connection_id: str, user=Depends(get_verified_user)):
    connection = await _get_connection_or_404(connection_id)
    if connection.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail='Bot connection not found')
    return _login_response(await _sidecar_request('POST', f'/v1/connections/{quote(connection_id, safe="")}/login'))


@router.get('/bindings')
async def get_bindings(user=Depends(get_verified_user)):
    _require_enabled()
    return [item.model_dump() for item in await BotGateway.list_bindings(user_id=user.id)]


@router.delete('/bindings/{binding_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_binding(binding_id: str, user=Depends(get_verified_user)):
    _require_enabled()
    if not await BotGateway.unbind(binding_id, user_id=user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Binding not found')
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get('/admin/bindings')
async def get_admin_bindings(user=Depends(get_admin_user), db: AsyncSession = Depends(get_async_session)):
    _require_enabled()
    bindings = await BotGateway.list_bindings(include_disabled=True)
    response = []
    for item in bindings:
        owner = await Users.get_user_by_id(item.user_id, db=db)
        payload = item.model_dump()
        payload.update(
            {
                'user_name': owner.name if owner else None,
                'user_username': owner.username if owner else None,
                'user_email': owner.email if owner else None,
            }
        )
        response.append(payload)
    return response


@router.delete('/admin/bindings/{binding_id}', status_code=status.HTTP_204_NO_CONTENT)
async def delete_admin_binding(binding_id: str, user=Depends(get_admin_user)):
    _require_enabled()
    if not await BotGateway.block_binding(binding_id, blocked_by=user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Binding not found')
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/admin/bindings/{binding_id}/unblock', status_code=status.HTTP_204_NO_CONTENT)
async def unblock_admin_binding(binding_id: str, user=Depends(get_admin_user)):
    _require_enabled()
    if not await BotGateway.unblock_binding(binding_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Blocked binding not found')
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _wire_reply(text: str | list[str]) -> dict[str, Any] | None:
    if isinstance(text, str):
        return {'text': text[:BOT_GATEWAY_MAX_REPLY_CHARS]}

    messages: list[str] = []
    remaining = BOT_GATEWAY_MAX_REPLY_CHARS
    for item in text:
        message = item.strip()
        if not message or remaining <= 0:
            continue
        message = message[:remaining]
        messages.append(message)
        remaining -= len(message)
    if not messages:
        return None
    return {
        'text': '\n\n'.join(messages)[:BOT_GATEWAY_MAX_REPLY_CHARS],
        'messages': messages,
    }


def _wire_response(event_id: str, text: str | list[str] | None = None, *, ignored: bool = False) -> dict[str, Any]:
    return {
        'version': '1.0',
        'event_id': event_id,
        'status': 'ignored' if ignored else 'ok',
        'reply': _wire_reply(text) if text is not None and not ignored else None,
    }


@internal_router.get('/media/{token}')
async def get_bot_media(token: str):
    payload = _decode_media_token(token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Media link expired or invalid')

    file = await Files.get_file_by_id(str(payload['file_id']))
    if not file or str(file.user_id) != str(payload['user_id']):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Media not found')

    metadata = file.meta if isinstance(file.meta, dict) else {}
    content_type = str(metadata.get('content_type') or '').lower()
    if not content_type.startswith('image/'):
        guessed = mimetypes.guess_type(str(file.filename or ''))[0] or ''
        content_type = guessed.lower()
    if not content_type.startswith('image/'):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Media type not allowed')

    try:
        file_path = Path(await asyncio.to_thread(Storage.get_file, file.path))
    except Exception:
        log.exception('Failed to resolve bot media file %s', file.id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Media not found')
    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Media not found')
    return FileResponse(file_path, media_type=content_type)


async def _complete(record_id: str, request_nonce: str, response: dict[str, Any]) -> dict[str, Any]:
    if not await BotGateway.complete_event(record_id, request_nonce, response):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='Bot gateway event lease was lost',
        )
    return response


async def _accessible_models(request: Request, user: UserModel) -> list[dict]:
    models = list(getattr(request.app.state, 'MODELS', {}).values())
    if not models:
        models = await get_all_models(request, user=user)
    models = await get_filtered_models(models, user)
    return [model for model in models if model.get('info', {}).get('meta', {}).get('hidden') is not True]


def _model_display_name(model: dict) -> str:
    name = model.get('name')
    return str(name).strip() if name and str(name).strip() else '未命名模型'


def _model_for_argument(argument: str, models: list[dict]) -> dict | None:
    if argument.isdigit():
        index = int(argument) - 1
        return models[index] if 0 <= index < len(models) else None
    normalized = argument.casefold()
    return next(
        (
            model
            for model in models
            if str(model.get('id') or '').casefold() == normalized
            or _model_display_name(model).casefold() == normalized
        ),
        None,
    )


def _model_name_for_id(model_id: str, models: list[dict]) -> str:
    model = next((item for item in models if item.get('id') == model_id), None)
    return _model_display_name(model) if model else '未命名模型'


async def _resolve_model(
    request: Request,
    user: UserModel,
    conversation: BotGatewayConversationModel,
) -> tuple[str, list[dict]]:
    models = await _accessible_models(request, user)
    available = {model['id']: model for model in models}
    candidates: list[str] = []
    if conversation.model_id:
        candidates.append(conversation.model_id)
    settings = user.settings.model_dump() if user.settings else {}
    ui_settings = settings.get('ui') if isinstance(settings.get('ui'), dict) else {}
    user_setting = await BotGateway.get_user_setting(user.id)
    if user_setting.default_model_id:
        candidates.append(user_setting.default_model_id)
    candidates.extend(ui_settings.get('models') or [])
    policy = await _gateway_policy()
    if policy['recommended_model_id']:
        candidates.append(str(policy['recommended_model_id']))
    candidates.extend(
        model_id.strip() for model_id in str(await Config.get('ui.default_models') or '').split(',') if model_id.strip()
    )
    candidates.extend(available)
    model_id = next((candidate for candidate in candidates if candidate in available), None)
    if model_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='No accessible RyanAI model')
    if conversation.model_id and conversation.model_id != model_id:
        await BotGateway.update_conversation(conversation.id, {'model_id': None})
    return model_id, models


def _build_chat_request(source: Request, user: UserModel) -> Request:
    token = create_token(
        {'id': user.id, 'typ': 'bot_gateway'},
        expires_delta=dt.timedelta(hours=1),
    )
    request = Request(
        {
            'type': 'http',
            'asgi': {'version': '3.0', 'spec_version': '2.0'},
            'method': 'POST',
            'path': '/api/v1/internal/bot-gateway/chat',
            'query_string': b'',
            'headers': Headers({'user-agent': 'RyanAI-Bot-Gateway'}).raw,
            'client': ('127.0.0.1', 0),
            'server': ('127.0.0.1', 80),
            'scheme': 'http',
            'app': source.app,
        }
    )
    request.state.token = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token)
    request.state.enable_api_keys = False
    request.state.internal = True
    request.state.user = user
    return request


async def _import_attachments(
    request: Request,
    user: UserModel,
    event: InboundEvent,
    form: Any,
) -> list[dict[str, Any]]:
    if not event.attachments:
        return []
    from open_webui.routers.files import upload_file_handler

    result = []
    for descriptor in event.attachments:
        upload = form.get(descriptor.field_name)
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing bot gateway attachment')
        content = await upload.read()
        await upload.seek(0)
        if len(content) != descriptor.size or hashlib.sha256(content).hexdigest() != descriptor.sha256:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Bot gateway attachment mismatch')
        if (upload.content_type or 'application/octet-stream').lower() != descriptor.content_type.lower():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Bot gateway attachment type mismatch')
        uploaded = await upload_file_handler(
            request,
            file=upload,
            metadata={
                'source': 'bot_gateway',
                'channel': event.channel,
                'external_attachment_id': descriptor.id,
            },
            process=True,
            process_in_background=False,
            user=user,
            background_tasks=None,
            db=None,
        )
        file_id = uploaded.id if hasattr(uploaded, 'id') else uploaded['id']
        meta = uploaded.meta if hasattr(uploaded, 'meta') else uploaded.get('meta', {})
        content_type = (meta or {}).get('content_type') or descriptor.content_type
        is_image = content_type.startswith('image/')
        result.append(
            {
                'type': 'image' if is_image else 'file',
                'id': file_id,
                'url': file_id,
                'name': descriptor.file_name,
                'content_type': content_type,
                'size': descriptor.size,
                'status': 'uploaded',
                **({'context': 'full'} if not is_image else {}),
            }
        )
    return result


def _is_document_attachment(file: Any) -> bool:
    if not isinstance(file, dict):
        return False
    content_type = str(file.get('content_type') or '').lower()
    return file.get('type') != 'image' and not content_type.startswith('image/')


def _conversation_context_files(
    message_list: list[dict[str, Any]],
    current_files: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    normalized_current = []
    has_current_document = False
    for file in current_files:
        if not isinstance(file, dict):
            continue
        item = dict(file)
        if _is_document_attachment(item):
            item['context'] = 'full'
            has_current_document = True
        normalized_current.append(item)

    if has_current_document:
        return normalized_current

    inherited_documents = []
    for message in reversed(message_list):
        if message.get('role') != 'user':
            continue
        inherited_documents = [
            {**file, 'context': 'full'}
            for file in message.get('files', [])
            if _is_document_attachment(file)
        ]
        if inherited_documents:
            break

    seen = set()
    result = []
    for file in [*normalized_current, *inherited_documents]:
        identity = file.get('id') or file.get('url') or json.dumps(file, sort_keys=True)
        if identity in seen:
            continue
        seen.add(identity)
        result.append(file)
    return result


async def _prepare_chat(
    event: InboundEvent,
    user: UserModel,
    conversation: BotGatewayConversationModel,
    model_id: str,
    files: list[dict[str, Any]],
) -> tuple[BotGatewayConversationModel, str, str, str | None]:
    existing_chat = (
        await Chats.get_chat_by_id_and_user_id(conversation.chat_id, user.id) if conversation.chat_id else None
    )
    parent_id = existing_chat.current_message_id if existing_chat else None
    user_message_id = str(uuid4())
    assistant_message_id = str(uuid4())
    if existing_chat is None:
        chat_id = str(uuid4())
        user_message = {
            'id': user_message_id,
            'parentId': None,
            'childrenIds': [assistant_message_id],
            'role': 'user',
            'content': event.message.text,
            'models': [model_id],
            'files': files,
            'timestamp': int(time.time()),
            'meta': {'source': 'bot_gateway', 'channel': event.channel},
        }
        assistant_message = {
            'id': assistant_message_id,
            'parentId': user_message_id,
            'childrenIds': [],
            'role': 'assistant',
            'content': '',
            'done': False,
            'model': model_id,
            'timestamp': int(time.time()),
        }
        created_at = int(time.time())
        day_start, day_end = _bot_chat_day_bounds(created_at)
        title_lock_key = f'bot-chat-title:{user.id}:{event.channel}:{day_start}'
        async with _conversation_lock(title_lock_key):
            sequence = await Chats.get_next_bot_chat_sequence(
                user.id,
                event.channel,
                day_start,
                day_end,
            )
            chat = await Chats.insert_new_chat(
                chat_id,
                user.id,
                ChatForm(
                    chat={
                        'id': chat_id,
                        'title': format_bot_chat_title(event.channel, created_at, sequence),
                        'models': [model_id],
                        'history': {
                            'currentId': assistant_message_id,
                            'messages': {
                                user_message_id: user_message,
                                assistant_message_id: assistant_message,
                            },
                        },
                        'messages': [{'role': 'user', 'content': event.message.text}],
                        'files': files,
                        'tags': [],
                        'timestamp': int(time.time() * 1000),
                    },
                ),
                internal_meta={
                    'source': 'bot_gateway',
                    'channel': event.channel,
                    'connection_id': event.connection_id,
                },
            )
        if chat is None:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail='Failed to create chat')
        conversation = await BotGateway.update_conversation(conversation.id, {'chat_id': chat_id}) or conversation
    else:
        chat_id = existing_chat.id
    return conversation, chat_id, user_message_id, parent_id


async def _run_chat(  # noqa: C901
    source_request: Request,
    event: InboundEvent,
    user: UserModel,
    conversation: BotGatewayConversationModel,
    model_id: str,
    files: list[dict[str, Any]],
    event_record_id: str,
    event_request_nonce: str,
) -> str | list[str]:
    conversation, chat_id, user_message_id, parent_id = await _prepare_chat(
        event,
        user,
        conversation,
        model_id,
        files,
    )
    assistant_message_id = str(uuid4())
    if parent_id is None:
        chat = await Chats.get_chat_by_id(chat_id)
        assistant_message_id = chat.current_message_id if chat and chat.current_message_id else assistant_message_id

    if not await BotGateway.set_event_target(
        event_record_id,
        event_request_nonce,
        binding_id=conversation.binding_id,
        conversation_id=conversation.id,
        chat_id=chat_id,
        assistant_message_id=assistant_message_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='Bot gateway event lease was lost',
        )
    request = _build_chat_request(source_request, user)
    model = request.app.state.MODELS.get(model_id, {})
    meta = model.get('info', {}).get('meta', {})
    tool_ids = list(meta.get('toolIds') or [])
    filter_ids = list(meta.get('defaultFilterIds') or [])
    terminal_id = meta.get('terminalId')
    default_features = set(meta.get('defaultFeatureIds') or [])
    capabilities = meta.get('capabilities') or {}
    features = {}
    if 'web_search' in default_features and capabilities.get('web_search') and await Config.get('web.search.enable'):
        features['web_search'] = True
    if (
        'image_generation' in default_features
        and capabilities.get('image_generation')
        and await Config.get('image_generation.enable')
    ):
        features['image_generation'] = True

    prompt = event.message.text.strip() or '请查看并处理我发送的附件。'
    chat = await Chats.get_chat_by_id(chat_id)
    history = (chat.chat or {}).get('history') if chat else {}
    history_messages = history.get('messages') if isinstance(history, dict) else {}
    message_list = get_message_list(history_messages or {}, parent_id) if parent_id else []
    user_message = {
        'id': user_message_id,
        'parentId': parent_id,
        'childrenIds': [assistant_message_id],
        'role': 'user',
        'content': prompt,
        'models': [model_id],
        'files': files,
        'timestamp': int(time.time()),
        'meta': {'source': 'bot_gateway', 'channel': event.channel, 'event_id': event.event_id},
    }
    context_files = _conversation_context_files(message_list, files)
    form_data: dict[str, Any] = {
        'model': model_id,
        'messages': [*message_list, dict(user_message)],
        'stream': True,
        'chat_id': chat_id,
        'id': assistant_message_id,
        'parent_id': parent_id,
        'user_message': user_message,
        'session_id': f'bot-gateway:{conversation.id}',
        'background_tasks': {},
        'files': context_files or None,
    }
    if tool_ids:
        form_data['tool_ids'] = tool_ids
    if filter_ids:
        form_data['filter_ids'] = filter_ids
    if terminal_id:
        form_data['terminal_id'] = terminal_id
    if features:
        form_data['features'] = features

    handler = getattr(request.app.state, 'CHAT_COMPLETION_HANDLER', None)
    if not callable(handler):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='RyanAI chat handler is unavailable',
        )
    if not await BotGateway.renew_event_lease(event_record_id, event_request_nonce):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='Bot gateway event lease was lost',
        )
    await handler(request, form_data, user=user)
    message = await Chats.get_message_by_id_and_message_id(chat_id, assistant_message_id)
    if not message:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail='RyanAI did not persist a response')
    error = message.get('error')
    if error:
        detail = error.get('content') if isinstance(error, dict) else str(error)
        return str(detail or 'Ryan AI 暂时无法处理这条消息。')
    text = message.get('content') or get_output_text(message.get('output'))
    image_urls = _generated_image_urls(message, user.id)
    if image_urls:
        await BotGateway.update_conversation(conversation.id, {'last_event_at': int(time.time())})
        if text:
            return [str(text), *image_urls]
        return image_urls
    if not text:
        text = 'Ryan AI 已完成处理，请在网页端查看该会话的结果。'
    await BotGateway.update_conversation(conversation.id, {'last_event_at': int(time.time())})
    return str(text)


async def _handle_command(  # noqa: C901
    request: Request,
    event: InboundEvent,
    binding: BotGatewayBindingModel | None,
    command: str,
    argument: str | None,
) -> str | list[str]:
    if command == 'help':
        return _command_guide()
    if command == 'status' and binding is None:
        return '当前微信/QQ账号尚未绑定 Ryan AI。请先在 Ryan AI 设置中生成绑定码，再发送 /bind <绑定码>。'
    if command == 'bind':
        if event.conversation.type != 'private':
            return '为保护账号安全，请在机器人私聊中完成绑定。'
        if binding is not None:
            return '当前账号已经绑定 Ryan AI；如需更换账号，请先执行 /unbind。'
        if not argument:
            return '用法：/bind <绑定码>'
        try:
            await BotGateway.bind_with_code(
                connection_id=event.connection_id,
                channel=event.channel,
                external_user_id=event.sender.id,
                display_name=event.sender.name,
                code_hash=hash_bot_gateway_binding_code(argument),
            )
            return _binding_messages()
        except BotGatewayBindingError as exc:
            messages = {
                'invalid_or_expired_code': '绑定码无效或已过期，请在 Ryan AI 中重新生成。',
                'channel_mismatch': '该绑定码不适用于当前渠道，请生成对应的微信或 QQ 绑定码。',
                'identity_already_bound': '当前账号已绑定其他 Ryan AI 账号，请先解绑或联系管理员。',
                'identity_blocked': '当前微信/QQ身份已被管理员封禁，请联系管理员处理。',
                'user_unavailable': '对应的 Ryan AI 账号当前不可用。',
            }
            return messages.get(exc.code, '绑定失败，请重新生成绑定码后再试。')
    if binding is None:
        return '请先在 Ryan AI 设置中生成绑定码，然后在私聊中发送 /bind <绑定码>。'
    if command == 'unbind':
        if event.conversation.type != 'private':
            return '为保护账号安全，请在机器人私聊中执行解绑。'
        if (argument or '').lower() == 'confirm':
            if await BotGateway.unbind(binding.id, user_id=binding.user_id, require_confirmation=True):
                return '解绑成功。Ryan AI 中原有聊天记录仍会保留。'
            return '解绑确认已过期，请重新发送 /unbind。'
        await BotGateway.request_unbind(binding.id, binding.user_id)
        return '确认解绑请在 5 分钟内发送 /unbind confirm。原有 Ryan AI 聊天记录不会被删除。'

    user = await Users.get_user_by_id(binding.user_id)
    if user is None or user.role not in {'user', 'admin'}:
        return '绑定的 Ryan AI 账号当前不可用，请联系管理员。'
    conversation = await BotGateway.get_or_create_conversation(
        binding=binding,
        conversation_type=event.conversation.type,
        conversation_id=event.conversation.id,
        sender_id=event.sender.id,
    )
    if command == 'new':
        await BotGateway.update_conversation(conversation.id, {'chat_id': None})
        return '已开始新的 Ryan AI 会话。当前模型设置保持不变。'
    if command == 'points':
        credit = Credits.init_credit_by_user_id(user.id)
        return f'当前积分：{credit.credit}'
    if command == 'models':
        models = await _accessible_models(request, user)
        available = '\n'.join(
            f'{index}. {_model_display_name(item)}' for index, item in enumerate(models, start=1)
        )
        suffix = '\n发送 /模型 <序号或名称> 切换模型。' if models else ''
        return f'可用模型：\n{available or "（无可用模型）"}{suffix}'
    if command == 'history':
        entries = await _conversation_history_entries(user.id, binding.id, limit=20)
        if not entries:
            return '暂无 Ryan AI 历史会话。'
        lines = [
            f'{index}. {title}{"（当前）" if item.chat_id == conversation.chat_id else ""}'
            for index, (item, title) in enumerate(entries, start=1)
        ]
        return '历史会话：\n' + '\n'.join(lines) + '\n发送 /会话 <序号> 继续，例如：/会话 1'
    if command == 'conversation':
        if not argument:
            return '用法：/会话 <序号>，请先发送 /历史 查看列表。'
        title: str | None = None
        if argument.isdigit():
            entries = await _conversation_history_entries(user.id, binding.id, limit=20)
            index = int(argument) - 1
            if index < 0 or index >= len(entries):
                return '会话序号不存在，请重新发送 /历史 查看列表。'
            target, title = entries[index]
        else:
            target = await BotGateway.get_conversation(argument, user.id, binding_id=binding.id)
        if target is None or not target.chat_id:
            return '会话不存在，或尚未产生 Ryan AI 聊天记录。'
        await BotGateway.update_conversation(conversation.id, {'chat_id': target.chat_id, 'model_id': target.model_id})
        if title is None:
            chat = await Chats.get_chat_by_id_and_user_id(target.chat_id, user.id)
            title = _history_chat_title(chat, target.created_at)
        return f'已切换到“{title}”，请继续发送消息。'
    model_id, models = await _resolve_model(request, user, conversation)
    if command == 'status':
        return (
            f'已绑定 Ryan AI；渠道：{event.channel}；'
            f'当前模型：{_model_name_for_id(model_id, models)}；连接状态正常。'
        )
    if command == 'model':
        if not argument:
            available = '\n'.join(
                f'{index}. {_model_display_name(model)}'
                for index, model in enumerate(models[:20], start=1)
            )
            return (
                f'当前模型：{_model_name_for_id(model_id, models)}\n'
                f'可用模型：\n{available}\n发送 /模型 <序号或名称> 切换模型。'
            )
        if argument.lower() == 'default':
            await BotGateway.update_conversation(conversation.id, {'model_id': None})
            refreshed, refreshed_models = await _resolve_model(
                request,
                user,
                conversation.model_copy(update={'model_id': None}),
            )
            return f'已恢复默认模型：{_model_name_for_id(refreshed, refreshed_models)}'
        selected = _model_for_argument(argument, models)
        if selected is None:
            return '模型不存在或当前 Ryan AI 账号无权使用。发送 /模型列表 查看可用模型。'
        selected_id = str(selected['id'])
        await BotGateway.update_conversation(conversation.id, {'model_id': selected_id})
        return f'当前会话已切换到模型：{_model_display_name(selected)}'
    return '未知命令。发送 /help 查看帮助。'


async def _recover_persisted_reply(
    record: BotGatewayEventModel,
    user_id: str,
) -> str | list[str] | None:
    """Recover a reply persisted before a worker died, avoiding a second model call."""
    if not record.chat_id or not record.assistant_message_id:
        return None
    message = await Chats.get_message_by_id_and_message_id(record.chat_id, record.assistant_message_id)
    if not message or message.get('done') is False:
        return None
    text = message.get('content') or get_output_text(message.get('output'))
    image_urls = _generated_image_urls(message, user_id)
    if image_urls:
        return [str(text), *image_urls] if text else image_urls
    return str(text) if text else None


@internal_router.post('/events')
async def receive_event(  # noqa: C901
    request: Request,
    db: AsyncSession = Depends(get_async_session),
):
    nonce, _, _ = await _verify_internal_request(request)
    now = int(time.time())
    if not await BotGateway.claim_request_nonce(
        nonce,
        expires_at=now + BOT_GATEWAY_NONCE_RETENTION_SECONDS,
        db=db,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='HMAC nonce has already been used',
        )
    try:
        await BotGateway.cleanup_expired_records(now=now, db=db)
    except Exception:
        log.exception('Bot gateway retention cleanup failed')

    try:
        form = await request.form()
        raw_event = form.get('event')
        if not isinstance(raw_event, str):
            raise ValueError('event part is required')
        event = InboundEvent.model_validate_json(raw_event)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid bot gateway event') from exc

    semantic_json = json.dumps(event.model_dump(mode='json'), sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    semantic_hash = hashlib.sha256(semantic_json.encode()).hexdigest()
    connection = await BotGateway.get_connection(event.connection_id)
    if connection is None or connection.channel != event.channel:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Bot connection not found')
    policy = await _gateway_policy()
    if not policy['enabled'] or not policy[f'{event.channel}_enabled']:
        return _wire_response(event.event_id, ignored=True)

    try:
        record, acquired = await BotGateway.claim_event(
            connection_id=event.connection_id,
            event_id=event.event_id,
            request_hash=semantic_hash,
            request_nonce=nonce,
            conversation_type=event.conversation.type,
            external_conversation_id=event.conversation.id,
            external_sender_id=event.sender.id,
            lease_seconds=BOT_GATEWAY_EVENT_LEASE_SECONDS,
            db=db,
        )
    except BotGatewayEventConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if not acquired:
        if record.status == 'completed' and record.response is not None:
            return record.response
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='Bot gateway event is already processing')

    lock_key = f'{event.connection_id}:{event.conversation.type}:{event.conversation.id}:{event.sender.id}'
    try:
        async with _event_lease(record.id, record.request_nonce):
            async with _conversation_lock(lock_key):
                if not connection.enabled:
                    return await _complete(
                        record.id,
                        record.request_nonce,
                        _wire_response(event.event_id, ignored=True),
                    )
                if event.conversation.type == 'group':
                    group = await BotGateway.upsert_group(
                        connection_id=event.connection_id,
                        external_group_id=event.conversation.id,
                        name=event.conversation.name,
                    )
                    if not group.allowed or not event.message.mentions_bot:
                        return await _complete(
                            record.id,
                            record.request_nonce,
                            _wire_response(event.event_id, ignored=True),
                        )

                binding = await BotGateway.get_enabled_binding(event.connection_id, event.sender.id)
                if event.conversation.type == 'group' and binding is None:
                    return await _complete(
                        record.id,
                        record.request_nonce,
                        _wire_response(event.event_id, ignored=True),
                    )

                if binding is not None and record.binding_id == binding.id and record.attempts > 1:
                    recovered_reply = await _recover_persisted_reply(record, binding.user_id)
                    if recovered_reply is not None:
                        return await _complete(
                            record.id,
                            record.request_nonce,
                            _wire_response(event.event_id, recovered_reply),
                        )

                command = parse_bot_gateway_command(event.message.text)
                if command:
                    reply = await _handle_command(request, event, binding, *command)
                    return await _complete(
                        record.id,
                        record.request_nonce,
                        _wire_response(event.event_id, reply),
                    )
                if binding is None:
                    reply = '请先在 Ryan AI 设置中生成绑定码，然后在机器人私聊中发送 /bind <绑定码>。'
                    return await _complete(
                        record.id,
                        record.request_nonce,
                        _wire_response(event.event_id, reply),
                    )

                user = await Users.get_user_by_id(binding.user_id)
                if user is None or user.role not in {'user', 'admin'}:
                    reply = '绑定的 Ryan AI 账号当前不可用，请联系管理员。'
                    return await _complete(
                        record.id,
                        record.request_nonce,
                        _wire_response(event.event_id, reply),
                    )
                await BotGateway.touch_binding(binding.id, event.sender.name)
                conversation = await BotGateway.get_or_create_conversation(
                    binding=binding,
                    conversation_type=event.conversation.type,
                    conversation_id=event.conversation.id,
                    sender_id=event.sender.id,
                )
                model_id, _ = await _resolve_model(request, user, conversation)
                chat_request = _build_chat_request(request, user)
                files = await _import_attachments(chat_request, user, event, form)
                reply = await _run_chat(
                    request,
                    event,
                    user,
                    conversation,
                    model_id,
                    files,
                    record.id,
                    record.request_nonce,
                )
                return await _complete(
                    record.id,
                    record.request_nonce,
                    _wire_response(event.event_id, reply),
                )
    except HTTPException as exc:
        await BotGateway.fail_event(record.id, record.request_nonce, str(exc.detail))
        raise
    except Exception as exc:
        log.exception('Bot gateway event %s failed', event.event_id)
        await BotGateway.fail_event(record.id, record.request_nonce, str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail='RyanAI failed to process the event',
        ) from exc
