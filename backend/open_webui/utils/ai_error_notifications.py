from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import html
import logging
import re
import time
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from open_webui.config import (
    ADMIN_EMAIL,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USERNAME,
    WEBUI_URL,
)
from open_webui.models.config import Config
from open_webui.utils.smtp import send_email

log = logging.getLogger(__name__)

DEFAULT_COOLDOWN_SECONDS = 600
MAX_ERROR_LENGTH = 2000
NON_ALERT_CATEGORIES = {'insufficient_credit'}
_memory_cooldowns: dict[str, dict[str, float | int]] = {}
_memory_lock = asyncio.Lock()
_notification_tasks: set[asyncio.Task] = set()

_SECRET_PATTERNS = (
    re.compile(r'(?i)(authorization\s*[:=]\s*)([^,;\r\n]+)'),
    re.compile(r'(?i)(bearer\s+)([a-z0-9._~+\-/=]+)'),
    re.compile(r'(?i)((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["\']?)([^\s,"\']+)'),
    re.compile(r'\bsk-[A-Za-z0-9_-]{8,}\b'),
)


class AIResponseFailure(Exception):
    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _config_int(value, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def _config_bool(value) -> bool:
    return value if isinstance(value, bool) else str(value or '').lower() == 'true'


def _extract_status_code(error_text: str, status_code: int | None = None) -> int | None:
    if status_code is not None:
        try:
            return int(status_code)
        except (TypeError, ValueError):
            pass

    match = re.search(r'\b([45]\d{2})\b', error_text)
    return int(match.group(1)) if match else None


def classify_ai_error(error, status_code: int | None = None) -> tuple[str, int | None]:
    error_text = str(error or '')
    status_code = _extract_status_code(error_text, status_code)
    marker = error_text.lower()

    if any(
        value in marker
        for value in (
            '积分不足',
            '余额不足',
            'insufficient credit',
            'not enough credit',
        )
    ):
        return 'insufficient_credit', status_code
    if any(
        value in marker
        for value in (
            'unexpected eof',
            'stream ended: reason=eof',
            'response body closed',
            'not enough data to satisfy transfer length header',
            'transferencodingerror',
            'stream disconnected before valid content',
            'internal_error; received from peer',
            'stream error: stream id',
        )
    ):
        return 'response_interrupted', status_code
    if any(
        value in marker
        for value in (
            'field messages is required',
            'messages is required',
            'missing messages',
            '缺少有效的对话内容',
            '请求中缺少有效的对话内容',
        )
    ):
        return 'invalid_request', status_code
    if status_code == 429 or any(value in marker for value in ('rate limit', 'too many requests', 'quota exceeded')):
        return 'rate_limited', status_code
    if status_code in (401, 403) or any(
        value in marker for value in ('authentication failed', 'unauthorized', 'invalid api key', 'permission denied')
    ):
        return 'authentication_failed', status_code
    if (status_code == 404 and any(value in marker for value in ('model', 'not found', 'does not exist'))) or (
        'model not found' in marker
    ):
        return 'model_not_found', status_code
    if any(
        value in marker
        for value in ('context length', 'maximum context', 'too many tokens', 'token limit', 'context window')
    ):
        return 'context_length_exceeded', status_code
    if any(value in marker for value in ('content filter', 'content policy', 'safety policy', 'moderation')):
        return 'content_filtered', status_code
    if any(value in marker for value in ('timed out', 'timeout', 'deadline exceeded')):
        return 'timeout', status_code
    if any(
        value in marker
        for value in (
            'connection error',
            'connection refused',
            'cannot connect',
            'network error',
            'dns',
            'server disconnected',
        )
    ):
        return 'network_error', status_code
    if any(value in marker for value in ('tool-call limit', 'tool call limit', 'tool failed', 'tool execution')):
        return 'tool_failed', status_code
    if status_code is not None and status_code >= 500:
        return 'server_failed', status_code
    return 'unknown_error', status_code


def get_user_facing_error(category: str, error_text: str = '') -> str:
    if category == 'insufficient_credit':
        return error_text or '当前积分不足，暂时无法完成本次请求。请获取积分后再试。'

    messages = {
        'response_interrupted': (
            'AI 回答在传输过程中意外中断。请先重试一次；如果仍然失败，请切换模型或新建对话后再试。'
        ),
        'invalid_request': '本次请求缺少有效的对话内容。请刷新页面后重试一次；如果仍然失败，请新建对话。',
        'rate_limited': '当前使用人数较多，请稍等片刻后重试一次。',
        'authentication_failed': '模型服务配置异常，请联系管理员处理。',
        'model_not_found': '当前模型暂不可用，请切换其他模型后重试。',
        'context_length_exceeded': '当前对话内容过长，请精简内容或新建对话后重试。',
        'content_filtered': '请求内容未通过模型的安全检查，请修改内容后重试。',
        'timeout': 'AI 响应时间过长。请先重试一次；如果仍然失败，请切换模型。',
        'network_error': '暂时无法连接模型服务。请稍后重试一次。',
        'tool_failed': '回答所需的工具执行失败。请重试一次；如果仍然失败，请关闭相关工具后再试。',
        'server_failed': '模型服务暂时异常。请先重试一次；如果仍然失败，请切换模型。',
    }
    return messages.get(category, 'AI 未能完成本次回答。请先重试一次；如果仍然失败，请切换模型或新建对话。')


def redact_sensitive_text(value) -> str:
    text = str(value or '')
    for pattern in _SECRET_PATTERNS:
        if pattern.groups >= 2:
            text = pattern.sub(r'\1[REDACTED]', text)
        else:
            text = pattern.sub('[REDACTED]', text)
    return text[:MAX_ERROR_LENGTH]


def redact_url(value: str | None) -> str:
    if not value:
        return ''
    try:
        parsed = urlsplit(str(value))
        hostname = parsed.hostname or ''
        netloc = hostname
        if parsed.port:
            netloc = f'{hostname}:{parsed.port}'
        return urlunsplit((parsed.scheme, netloc, parsed.path, '', ''))
    except Exception:
        return redact_sensitive_text(value)


def _model_id(model, fallback: str | None = None) -> str:
    if isinstance(model, dict):
        return str(model.get('id') or model.get('name') or fallback or '')
    return str(model or fallback or '')


def _provider_name(model, provider: str | None = None) -> str:
    if provider:
        return provider
    if isinstance(model, dict):
        return str(model.get('provider') or model.get('owned_by') or model.get('object') or '')
    return ''


async def _cooldown_decision(app, signature: str, cooldown: int) -> tuple[bool, int]:
    digest = hashlib.sha256(signature.encode('utf-8')).hexdigest()
    redis = getattr(getattr(app, 'state', None), 'redis', None)
    if redis is not None:
        gate_key = f'ai_error_notification:gate:{digest}'
        count_key = f'ai_error_notification:count:{digest}'
        try:
            acquired = await redis.set(gate_key, '1', ex=cooldown, nx=True)
            if acquired:
                repeat_count = await redis.get(count_key)
                await redis.delete(count_key)
                return True, int(repeat_count or 0)
            repeat_count = await redis.incr(count_key)
            await redis.expire(count_key, max(cooldown * 12, 86400))
            return False, int(repeat_count)
        except Exception:
            log.exception('Redis cooldown check failed; using in-memory AI error cooldown')

    now = time.monotonic()
    async with _memory_lock:
        if len(_memory_cooldowns) > 2048:
            expired = [key for key, value in _memory_cooldowns.items() if float(value['expires_at']) <= now]
            for key in expired:
                _memory_cooldowns.pop(key, None)
        entry = _memory_cooldowns.get(digest)
        if not entry or float(entry['expires_at']) <= now:
            repeat_count = int(entry.get('count', 0)) if entry else 0
            _memory_cooldowns[digest] = {'expires_at': now + cooldown, 'count': 0}
            return True, repeat_count
        entry['count'] = int(entry.get('count', 0)) + 1
        return False, int(entry['count'])


def _email_body(context: dict, repeated_count: int) -> str:
    def esc(value) -> str:
        return html.escape(str(value or ''))

    rows = [
        ('异常编号', context['incident_id']),
        ('发生时间', context['created_at']),
        ('错误分类', context['category']),
        ('HTTP 状态码', context.get('status_code') or '未知'),
        ('模型', context.get('model') or '未知'),
        ('供应商', context.get('provider') or '未知'),
        ('服务地址', context.get('base_url') or '未知'),
        ('用户 ID', context.get('user_id') or '未知'),
        ('用户姓名', context.get('user_name') or '未知'),
        ('用户邮箱', context.get('user_email') or '未知'),
        ('Chat ID', context.get('chat_id') or '未知'),
        ('Message ID', context.get('message_id') or '未知'),
        ('请求/事件 ID', context.get('request_id') or '未知'),
        ('上一冷却窗口重复次数', repeated_count),
    ]
    rows_html = ''.join(f'<tr><th align="left">{esc(label)}</th><td>{esc(value)}</td></tr>' for label, value in rows)
    chat_link = context.get('chat_link')
    chat_html = f'<p><a href="{esc(chat_link)}">打开相关会话</a></p>' if chat_link else ''
    return f"""
    <h2>AI 回答异常</h2>
    <table cellpadding="6" cellspacing="0" border="1">{rows_html}</table>
    <h3>脱敏后的系统错误</h3>
    <pre>{esc(context.get('error'))}</pre>
    {chat_html}
    <p><strong>隐私说明：</strong>出于隐私保护，本通知未包含用户提问正文、历史对话、上传文件内容或 AI 已生成内容。</p>
    """


async def _send_notification(receiver: str, subject: str, body: str, incident_id: str) -> None:
    try:
        await asyncio.to_thread(send_email, receiver=receiver, subject=subject, body=body)
    except Exception:
        log.exception('Failed to send AI error notification email for %s', incident_id)


def _schedule_notification(receiver: str, subject: str, body: str, incident_id: str) -> None:
    task = asyncio.create_task(_send_notification(receiver, subject, body, incident_id))
    _notification_tasks.add(task)
    task.add_done_callback(_notification_tasks.discard)


async def report_ai_response_failure(
    request,
    *,
    error,
    user=None,
    metadata: dict | None = None,
    model=None,
    status_code: int | None = None,
    category: str | None = None,
    provider: str | None = None,
    base_url: str | None = None,
) -> dict:
    metadata = metadata or {}
    error_text = redact_sensitive_text(error)
    model_id = _model_id(model, metadata.get('model_id'))
    state = getattr(request, 'state', None)
    provider_failure = (
        getattr(state, 'model_provider_failures', {}).get(model_id, {}) if state is not None and model_id else {}
    )
    provider = provider or provider_failure.get('provider')
    base_url = base_url or provider_failure.get('base_url')
    status_code = status_code or provider_failure.get('status')
    category = category or provider_failure.get('error_type')
    detected_category, detected_status = classify_ai_error(error_text, status_code)
    category = category or detected_category
    status_code = detected_status
    user_message = get_user_facing_error(category, error_text)
    incident_id = f'ERR-{dt.datetime.now(dt.UTC).strftime("%Y%m%d")}-{uuid4().hex[:8].upper()}'

    message_key = ':'.join(
        str(value or '')
        for value in (
            metadata.get('chat_id'),
            metadata.get('message_id'),
            model_id,
        )
    )
    incidents = getattr(state, 'ai_error_incidents', {}) if state is not None else {}
    if message_key and message_key in incidents:
        return incidents[message_key]

    payload = {
        'content': user_message,
        'technical_detail': error_text,
        'category': category,
        'status_code': status_code,
        'incident_id': incident_id,
        'admin_notification': 'disabled',
    }
    if state is not None and message_key:
        incidents[message_key] = payload
        state.ai_error_incidents = incidents

    if category in NON_ALERT_CATEGORIES:
        payload['admin_notification'] = 'not_required'
        return payload

    enabled = _config_bool(await Config.get('notifications.ai_error_email.enabled', False))
    if not enabled:
        return payload

    admin_email = str((await Config.get('auth.admin.email', ADMIN_EMAIL)) or '').strip()
    smtp_host = str((await Config.get('ui.smtp.host', SMTP_HOST)) or '').strip()
    smtp_port = str((await Config.get('ui.smtp.port', SMTP_PORT)) or '').strip()
    smtp_username = str((await Config.get('ui.smtp.username', SMTP_USERNAME)) or '').strip()
    smtp_password = str((await Config.get('ui.smtp.password', SMTP_PASSWORD)) or '').strip()
    if not admin_email or not smtp_host or smtp_port not in ('465', '587') or not smtp_username or not smtp_password:
        payload['admin_notification'] = 'failed'
        log.warning('AI error notification is enabled but ADMIN_EMAIL or SMTP configuration is incomplete')
        return payload

    provider_name = _provider_name(model, provider)
    cooldown = _config_int(
        await Config.get('notifications.ai_error_email.cooldown_seconds', DEFAULT_COOLDOWN_SECONDS),
        DEFAULT_COOLDOWN_SECONDS,
    )
    signature = f'{provider_name}|{model_id}|{category}|{status_code or ""}'
    should_send, repeated_count = await _cooldown_decision(request.app, signature, cooldown)
    payload['admin_notification'] = 'submitted'
    payload['notification_suppressed'] = not should_send
    if not should_send:
        return payload

    webui_url = str((await Config.get('webui.url', WEBUI_URL)) or '').rstrip('/')
    chat_id = str(metadata.get('chat_id') or '')
    user_id = str(getattr(user, 'id', '') or '')
    user_name = str(getattr(user, 'name', '') or '')
    user_email = str(getattr(user, 'email', '') or '')
    request_id = str(
        getattr(state, 'request_id', '')
        or request.headers.get('x-request-id', '')
        or request.headers.get('x-correlation-id', '')
    )
    context = {
        'incident_id': incident_id,
        'created_at': dt.datetime.now(dt.UTC).isoformat(),
        'category': category,
        'status_code': status_code,
        'model': model_id,
        'provider': provider_name,
        'base_url': redact_url(base_url),
        'user_id': user_id,
        'user_name': user_name,
        'user_email': user_email,
        'chat_id': chat_id,
        'message_id': str(metadata.get('message_id') or ''),
        'request_id': request_id,
        'chat_link': f'{webui_url}/c/{chat_id}' if webui_url and chat_id else '',
        'error': error_text,
    }
    subject_status = f'[{status_code}]' if status_code else ''
    subject = f'[RyanAI告警]{subject_status} {model_id or "AI"} 回答失败'
    _schedule_notification(admin_email, subject, _email_body(context, repeated_count), incident_id)
    return payload
