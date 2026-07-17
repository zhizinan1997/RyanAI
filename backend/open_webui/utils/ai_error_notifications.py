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
RECIPIENT_MODE_ADMIN = 'admin'
RECIPIENT_MODE_ADMIN_AND_USER = 'admin_and_user'
DEFAULT_RECIPIENT_MODE = RECIPIENT_MODE_ADMIN
VALID_RECIPIENT_MODES = {RECIPIENT_MODE_ADMIN, RECIPIENT_MODE_ADMIN_AND_USER}
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


def _normalize_recipient_mode(value) -> str:
    mode = str(value or DEFAULT_RECIPIENT_MODE).strip().lower().replace('-', '_')
    if mode in {'admin_only', 'admin'}:
        return RECIPIENT_MODE_ADMIN
    if mode in {'admin_and_user', 'admin_user', 'both', 'all'}:
        return RECIPIENT_MODE_ADMIN_AND_USER
    return DEFAULT_RECIPIENT_MODE


def _format_display_time(value: str) -> str:
    text = str(value or '').strip()
    if not text:
        return '未知'
    try:
        parsed = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
        return parsed.astimezone(dt.UTC).strftime('%Y-%m-%d %H:%M:%S UTC')
    except Exception:
        return text


def _category_label(category: str) -> str:
    labels = {
        'insufficient_credit': '积分不足',
        'response_interrupted': '回复中断',
        'invalid_request': '请求无效',
        'rate_limited': '请求限流',
        'authentication_failed': '鉴权失败',
        'model_not_found': '模型不可用',
        'context_length_exceeded': '上下文过长',
        'content_filtered': '内容过滤',
        'timeout': '响应超时',
        'network_error': '网络异常',
        'tool_failed': '工具执行失败',
        'server_failed': '服务异常',
        'unknown_error': '未知错误',
    }
    return labels.get(str(category or ''), str(category or '未知错误'))


def _render_detail_rows(rows: list[tuple[str, object]]) -> str:
    parts: list[str] = []
    for index, (label, value) in enumerate(rows):
        border = '' if index == len(rows) - 1 else 'border-bottom:1px solid #edf2f7;'
        parts.append(
            f'''
            <tr>
              <td style="padding:12px 0;{border}width:34%;vertical-align:top;font-size:12px;font-weight:700;letter-spacing:0.02em;color:#64748b;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                {html.escape(str(label))}
              </td>
              <td style="padding:12px 0;{border}vertical-align:top;font-size:13px;line-height:1.55;color:#0f172a;word-break:break-word;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                {html.escape(str(value if value not in (None, '') else '未知'))}
              </td>
            </tr>'''
        )
    return ''.join(parts)


def _render_email_shell(
    *,
    badge: str,
    title: str,
    subtitle: str,
    body_html: str,
    cta_url: str = '',
    cta_label: str = '',
    footer_note: str = '',
) -> str:
    badge_html = html.escape(badge)
    title_html = html.escape(title)
    subtitle_html = html.escape(subtitle)
    footer_html = html.escape(footer_note or '本邮件由 Ryan AI 自动发送，请勿直接回复。')
    cta_html = ''
    if cta_url and cta_label:
        cta_html = f'''
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
            <tr>
              <td style="border-radius:999px;background:linear-gradient(135deg,#38bdf8,#2563eb);box-shadow:0 12px 28px rgba(37,99,235,0.28);">
                <a href="{html.escape(cta_url)}" style="display:inline-block;padding:12px 22px;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                  {html.escape(cta_label)}
                </a>
              </td>
            </tr>
          </table>'''

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title_html}</title>
</head>
<body style="margin:0;padding:0;background:#edf3fb;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    {subtitle_html}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:linear-gradient(135deg,#edf3fb 0%,#f7fafc 42%,#dfe9f5 100%);padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:640px;">
          <tr>
            <td style="padding:0 0 16px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:12px;height:12px;border-radius:999px;background:linear-gradient(135deg,#38bdf8,#2563eb);box-shadow:0 6px 20px rgba(37,99,235,0.35);"></td>
                  <td style="padding-left:10px;font-size:14px;font-weight:700;letter-spacing:0.04em;color:#0f172a;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                    Ryan AI
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="border:1px solid rgba(255,255,255,0.72);border-radius:24px;background:rgba(255,255,255,0.94);box-shadow:0 36px 90px -42px rgba(15,23,42,0.28);overflow:hidden;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding:22px 28px 18px 28px;background:linear-gradient(135deg,rgba(56,189,248,0.16),rgba(37,99,235,0.10));border-bottom:1px solid rgba(226,232,240,0.9);">
                    <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(37,99,235,0.10);color:#1d4ed8;font-size:11px;font-weight:700;letter-spacing:0.04em;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                      {badge_html}
                    </div>
                    <div style="margin-top:14px;font-size:24px;line-height:1.25;font-weight:800;color:#0f172a;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                      {title_html}
                    </div>
                    <div style="margin-top:8px;font-size:14px;line-height:1.6;color:#64748b;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                      {subtitle_html}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 28px 10px 28px;">
                    {body_html}
                    {cta_html}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 28px 24px 28px;">
                    <div style="padding-top:16px;border-top:1px solid #edf2f7;font-size:12px;line-height:1.6;color:#94a3b8;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
                      {footer_html}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 8px 0 8px;font-size:11px;color:#94a3b8;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
              © Ryan AI · Intelligent Assistant
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>'''


def _admin_email_body(context: dict, repeated_count: int) -> str:
    rows = [
        ('异常编号', context.get('incident_id')),
        ('发生时间', _format_display_time(context.get('created_at'))),
        ('错误分类', _category_label(context.get('category'))),
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
    error_text = html.escape(str(context.get('error') or '无'))
    body_html = f'''
      <p style="margin:0 0 18px 0;font-size:14px;line-height:1.7;color:#334155;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
        检测到一次 AI 回答失败。以下为脱敏后的运维信息，便于定位与处理。
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 18px 0;">
        {_render_detail_rows(rows)}
      </table>
      <div style="margin:0 0 18px 0;padding:14px 16px;border-radius:16px;background:#f8fafc;border:1px solid #e2e8f0;">
        <div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:8px;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
          脱敏后的系统错误
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;color:#0f172a;font-family:Consolas,'SFMono-Regular',Menlo,monospace;">{error_text}</pre>
      </div>
      <p style="margin:0 0 18px 0;font-size:12px;line-height:1.6;color:#94a3b8;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
        隐私说明：本通知未包含用户提问正文、历史对话、上传文件内容或 AI 已生成内容。
      </p>
    '''
    return _render_email_shell(
        badge='ADMIN ALERT',
        title='AI 回答异常告警',
        subtitle=f"事件 {context.get('incident_id') or ''} · {_category_label(context.get('category'))}",
        body_html=body_html,
        cta_url=str(context.get('chat_link') or ''),
        cta_label='打开相关会话',
        footer_note='本邮件由 Ryan AI 自动发送给管理员。请优先检查模型连接、鉴权配置与上游服务状态。',
    )


def _user_email_body(context: dict) -> str:
    user_name = str(context.get('user_name') or '').strip()
    greeting = f'{html.escape(user_name)}，您好：' if user_name else '您好：'
    rows = [
        ('异常编号', context.get('incident_id')),
        ('发生时间', _format_display_time(context.get('created_at'))),
        ('模型', context.get('model') or '未知'),
        ('说明', context.get('user_message') or 'AI 未能完成本次回答，请稍后重试。'),
    ]
    body_html = f'''
      <p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
        {greeting}
      </p>
      <p style="margin:0 0 18px 0;font-size:14px;line-height:1.7;color:#334155;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
        您的一次 AI 对话请求未能成功完成。我们已记录该问题，并通知管理员处理。您可稍后重试，或切换其他模型后再试。
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 18px 0;">
        {_render_detail_rows(rows)}
      </table>
      <p style="margin:0 0 18px 0;font-size:12px;line-height:1.6;color:#94a3b8;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;">
        如问题持续出现，请联系管理员并提供上方异常编号。本通知未包含您的提问正文、历史对话、上传文件内容或 AI 已生成内容。
      </p>
    '''
    return _render_email_shell(
        badge='USER NOTICE',
        title='AI 回答失败通知',
        subtitle='本次对话未能完成，系统已自动记录',
        body_html=body_html,
        cta_url=str(context.get('chat_link') or ''),
        cta_label='返回相关会话',
        footer_note='本邮件由 Ryan AI 自动发送。如非本人操作，可忽略本通知。',
    )


# Keep the old name as an alias for any external/test callers.
def _email_body(context: dict, repeated_count: int) -> str:
    return _admin_email_body(context, repeated_count)




async def _send_notification(receiver: str, subject: str, body: str, incident_id: str) -> None:
    try:
        await asyncio.to_thread(send_email, receiver=receiver, subject=subject, body=body)
    except Exception:
        log.exception('Failed to send AI error notification email for %s to %s', incident_id, receiver)


def _schedule_notification(receiver: str, subject: str, body: str, incident_id: str) -> None:
    if not receiver:
        return
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
        'user_notification': 'disabled',
    }
    if state is not None and message_key:
        incidents[message_key] = payload
        state.ai_error_incidents = incidents

    if category in NON_ALERT_CATEGORIES:
        payload['admin_notification'] = 'not_required'
        payload['user_notification'] = 'not_required'
        return payload

    enabled = _config_bool(await Config.get('notifications.ai_error_email.enabled', False))
    if not enabled:
        return payload

    recipient_mode = _normalize_recipient_mode(
        await Config.get('notifications.ai_error_email.recipient_mode', DEFAULT_RECIPIENT_MODE)
    )
    notify_user = recipient_mode == RECIPIENT_MODE_ADMIN_AND_USER
    payload['recipient_mode'] = recipient_mode

    admin_email = str((await Config.get('auth.admin.email', ADMIN_EMAIL)) or '').strip()
    user_email = str(getattr(user, 'email', '') or '').strip() if notify_user else ''
    smtp_host = str((await Config.get('ui.smtp.host', SMTP_HOST)) or '').strip()
    smtp_port = str((await Config.get('ui.smtp.port', SMTP_PORT)) or '').strip()
    smtp_username = str((await Config.get('ui.smtp.username', SMTP_USERNAME)) or '').strip()
    smtp_password = str((await Config.get('ui.smtp.password', SMTP_PASSWORD)) or '').strip()
    smtp_ready = bool(smtp_host and smtp_port in ('465', '587') and smtp_username and smtp_password)
    if not smtp_ready or (not admin_email and not user_email):
        payload['admin_notification'] = 'failed'
        payload['user_notification'] = 'failed' if notify_user else 'disabled'
        log.warning(
            'AI error notification is enabled but SMTP configuration is incomplete, '
            'or neither ADMIN_EMAIL nor the user email is available'
        )
        return payload

    provider_name = _provider_name(model, provider)
    cooldown = _config_int(
        await Config.get('notifications.ai_error_email.cooldown_seconds', DEFAULT_COOLDOWN_SECONDS),
        DEFAULT_COOLDOWN_SECONDS,
    )
    signature = f'{provider_name}|{model_id}|{category}|{status_code or ""}'
    should_send, repeated_count = await _cooldown_decision(request.app, signature, cooldown)
    payload['notification_suppressed'] = not should_send
    if not should_send:
        payload['admin_notification'] = 'submitted' if admin_email else 'skipped'
        if notify_user:
            payload['user_notification'] = 'submitted' if user_email else 'skipped'
        else:
            payload['user_notification'] = 'disabled'
        return payload

    webui_url = str((await Config.get('webui.url', WEBUI_URL)) or '').rstrip('/')
    chat_id = str(metadata.get('chat_id') or '')
    user_id = str(getattr(user, 'id', '') or '')
    user_name = str(getattr(user, 'name', '') or '')
    actual_user_email = str(getattr(user, 'email', '') or '').strip()
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
        'user_email': actual_user_email,
        'user_message': user_message,
        'chat_id': chat_id,
        'message_id': str(metadata.get('message_id') or ''),
        'request_id': request_id,
        'chat_link': f'{webui_url}/c/{chat_id}' if webui_url and chat_id else '',
        'error': error_text,
    }
    subject_status = f'[{status_code}]' if status_code else ''
    admin_subject = f'[RyanAI告警]{subject_status} {model_id or "AI"} 回答失败'
    user_subject = f'[RyanAI]{subject_status} AI 回答失败通知'

    if admin_email:
        _schedule_notification(admin_email, admin_subject, _admin_email_body(context, repeated_count), incident_id)
        payload['admin_notification'] = 'submitted'
    else:
        payload['admin_notification'] = 'skipped'
        log.warning('AI error admin notification skipped: ADMIN_EMAIL is not configured')

    if not notify_user:
        payload['user_notification'] = 'disabled'
    elif actual_user_email and actual_user_email.lower() != admin_email.lower():
        _schedule_notification(actual_user_email, user_subject, _user_email_body(context), incident_id)
        payload['user_notification'] = 'submitted'
    elif actual_user_email and actual_user_email.lower() == admin_email.lower():
        payload['user_notification'] = 'merged_with_admin'
    else:
        payload['user_notification'] = 'skipped'

    return payload
