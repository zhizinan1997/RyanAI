from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from open_webui.utils import ai_error_notifications as notifications


class AIErrorClassificationTests(IsolatedAsyncioTestCase):
    def test_classifies_common_errors(self):
        cases = [
            ('Console API returned 429', None, 'rate_limited', 429),
            ('Unauthorized', 401, 'authentication_failed', 401),
            ('Model not found', 404, 'model_not_found', 404),
            ('context length exceeded', 400, 'context_length_exceeded', 400),
            ('request timed out', None, 'timeout', None),
            ('upstream failed', 503, 'server_failed', 503),
            ('Tool-call limit reached', None, 'tool_failed', None),
            ('unexpected EOF', None, 'response_interrupted', None),
            ('stream error: stream ID 1; INTERNAL_ERROR; received from peer', None, 'response_interrupted', None),
            ('您的绘图积分不足', 403, 'insufficient_credit', 403),
            ('field messages is required', 500, 'invalid_request', 500),
        ]
        for error, status, expected_category, expected_status in cases:
            with self.subTest(error=error):
                category, detected_status = notifications.classify_ai_error(error, status)
                self.assertEqual(category, expected_category)
                self.assertEqual(detected_status, expected_status)

    def test_redacts_secrets_and_url_credentials(self):
        error = 'Authorization: Bearer secret-token api_key=sk-abcdefghijk password=hunter2'
        redacted = notifications.redact_sensitive_text(error)
        self.assertNotIn('secret-token', redacted)
        self.assertNotIn('sk-abcdefghijk', redacted)
        self.assertNotIn('hunter2', redacted)
        self.assertEqual(
            notifications.redact_url('https://user:pass@example.com/v1/chat?api_key=secret'),
            'https://example.com/v1/chat',
        )


class AIErrorReportingTests(IsolatedAsyncioTestCase):
    def setUp(self):
        notifications._memory_cooldowns.clear()

    @staticmethod
    def request():
        return SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(redis=None, WEBUI_NAME='RyanAI')),
            state=SimpleNamespace(),
            headers={},
        )

    async def test_disabled_notification_returns_structured_error(self):
        with patch.object(notifications.Config, 'get', AsyncMock(return_value=False)):
            payload = await notifications.report_ai_response_failure(
                self.request(),
                error='Console API returned 429',
                metadata={'chat_id': 'chat-1', 'message_id': 'message-1'},
                model={'id': 'grok-4.3'},
            )

        self.assertEqual(payload['category'], 'rate_limited')
        self.assertEqual(payload['status_code'], 429)
        self.assertEqual(payload['admin_notification'], 'disabled')
        self.assertRegex(payload['incident_id'], r'^ERR-\d{8}-[A-F0-9]{8}$')

    async def test_insufficient_credit_does_not_notify_admin(self):
        with (
            patch.object(notifications.Config, 'get', AsyncMock(return_value=True)),
            patch.object(notifications, '_schedule_notification') as schedule,
        ):
            payload = await notifications.report_ai_response_failure(
                self.request(),
                error='您的绘图积分不足，请获取积分后再试。',
                status_code=403,
                metadata={'chat_id': 'chat-credit', 'message_id': 'message-credit'},
                model={'id': 'image-model'},
            )

        self.assertEqual(payload['category'], 'insufficient_credit')
        self.assertEqual(payload['admin_notification'], 'not_required')
        self.assertEqual(payload['content'], '您的绘图积分不足，请获取积分后再试。')
        schedule.assert_not_called()

    async def test_eof_returns_chinese_user_message_and_keeps_technical_detail(self):
        with patch.object(notifications.Config, 'get', AsyncMock(return_value=False)):
            payload = await notifications.report_ai_response_failure(
                self.request(),
                error='unexpected EOF',
                metadata={'chat_id': 'chat-eof', 'message_id': 'message-eof'},
                model={'id': 'gpt-lite'},
            )

        self.assertEqual(payload['category'], 'response_interrupted')
        self.assertIn('请先重试一次', payload['content'])
        self.assertEqual(payload['technical_detail'], 'unexpected EOF')

    async def test_submits_redacted_email_and_suppresses_duplicate(self):
        values = {
            'notifications.ai_error_email.enabled': True,
            'auth.admin.email': 'admin@example.com',
            'ui.smtp.host': 'smtp.example.com',
            'ui.smtp.port': '465',
            'ui.smtp.username': 'sender@example.com',
            'ui.smtp.password': 'smtp-password',
            'notifications.ai_error_email.cooldown_seconds': 600,
            'notifications.ai_error_email.recipient_mode': 'admin_and_user',
            'webui.url': 'https://ryan.example.com',
        }

        async def config_get(key, default=None):
            return values.get(key, default)

        scheduled = []

        def capture(receiver, subject, body, incident_id):
            scheduled.append((receiver, subject, body, incident_id))

        metadata = {
            'chat_id': 'chat-1',
            'message_id': 'message-1',
            'user_message': {'content': 'private user question'},
        }
        user = SimpleNamespace(id='user-1', name='Ryan', email='user@example.com')
        with (
            patch.object(notifications.Config, 'get', side_effect=config_get),
            patch.object(notifications, '_schedule_notification', side_effect=capture),
        ):
            first = await notifications.report_ai_response_failure(
                self.request(),
                error='Console API returned 429 api_key=sk-abcdefghijk',
                user=user,
                metadata=metadata,
                model={'id': 'grok-4.3', 'provider': 'console'},
            )
            second = await notifications.report_ai_response_failure(
                self.request(),
                error='Console API returned 429',
                user=user,
                metadata={**metadata, 'message_id': 'message-2'},
                model={'id': 'grok-4.3', 'provider': 'console'},
            )

        self.assertEqual(first['admin_notification'], 'submitted')
        self.assertEqual(first['user_notification'], 'submitted')
        self.assertEqual(first['recipient_mode'], 'admin_and_user')
        self.assertFalse(first['notification_suppressed'])
        self.assertEqual(second['admin_notification'], 'submitted')
        self.assertEqual(second['user_notification'], 'submitted')
        self.assertTrue(second['notification_suppressed'])
        self.assertEqual(len(scheduled), 2)

        receivers = [item[0] for item in scheduled]
        self.assertEqual(set(receivers), {'admin@example.com', 'user@example.com'})

        admin_mail = next(item for item in scheduled if item[0] == 'admin@example.com')
        user_mail = next(item for item in scheduled if item[0] == 'user@example.com')
        _, admin_subject, admin_body, _ = admin_mail
        _, user_subject, user_body, _ = user_mail

        self.assertIn('告警', admin_subject)
        self.assertIn('AI 回答失败通知', user_subject)
        self.assertNotIn('private user question', admin_body)
        self.assertNotIn('private user question', user_body)
        self.assertNotIn('sk-abcdefghijk', admin_body)
        self.assertNotIn('sk-abcdefghijk', user_body)
        self.assertIn('Ryan', admin_body)
        self.assertIn('chat-1', admin_body)
        self.assertIn('脱敏后的系统错误', admin_body)
        self.assertIn('Ryan AI', admin_body)
        self.assertIn('ADMIN ALERT', admin_body)
        self.assertIn('linear-gradient', admin_body)
        self.assertIn('说明', user_body)
        self.assertIn('USER NOTICE', user_body)
        self.assertNotIn('脱敏后的系统错误', user_body)

    async def test_merges_user_email_when_user_is_admin(self):
        values = {
            'notifications.ai_error_email.enabled': True,
            'auth.admin.email': 'admin@example.com',
            'ui.smtp.host': 'smtp.example.com',
            'ui.smtp.port': '465',
            'ui.smtp.username': 'sender@example.com',
            'ui.smtp.password': 'smtp-password',
            'notifications.ai_error_email.cooldown_seconds': 600,
            'notifications.ai_error_email.recipient_mode': 'admin_and_user',
            'webui.url': 'https://ryan.example.com',
        }

        async def config_get(key, default=None):
            return values.get(key, default)

        scheduled = []

        def capture(receiver, subject, body, incident_id):
            scheduled.append((receiver, subject, body, incident_id))

        user = SimpleNamespace(id='admin-1', name='Admin', email='admin@example.com')
        with (
            patch.object(notifications.Config, 'get', side_effect=config_get),
            patch.object(notifications, '_schedule_notification', side_effect=capture),
        ):
            payload = await notifications.report_ai_response_failure(
                self.request(),
                error='Console API returned 500',
                user=user,
                metadata={'chat_id': 'chat-admin', 'message_id': 'message-admin'},
                model={'id': 'grok-4.3', 'provider': 'console'},
            )

        self.assertEqual(payload['admin_notification'], 'submitted')
        self.assertEqual(payload['user_notification'], 'merged_with_admin')
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(scheduled[0][0], 'admin@example.com')

    async def test_admin_only_recipient_mode_skips_user_email(self):
        values = {
            'notifications.ai_error_email.enabled': True,
            'auth.admin.email': 'admin@example.com',
            'ui.smtp.host': 'smtp.example.com',
            'ui.smtp.port': '465',
            'ui.smtp.username': 'sender@example.com',
            'ui.smtp.password': 'smtp-password',
            'notifications.ai_error_email.cooldown_seconds': 600,
            'notifications.ai_error_email.recipient_mode': 'admin',
            'webui.url': 'https://ryan.example.com',
        }

        async def config_get(key, default=None):
            return values.get(key, default)

        scheduled = []

        def capture(receiver, subject, body, incident_id):
            scheduled.append((receiver, subject, body, incident_id))

        user = SimpleNamespace(id='user-2', name='Taylor', email='taylor@example.com')
        with (
            patch.object(notifications.Config, 'get', side_effect=config_get),
            patch.object(notifications, '_schedule_notification', side_effect=capture),
        ):
            payload = await notifications.report_ai_response_failure(
                self.request(),
                error='Console API returned 503',
                user=user,
                metadata={'chat_id': 'chat-admin-only', 'message_id': 'message-admin-only'},
                model={'id': 'gpt-lite', 'provider': 'console'},
            )

        self.assertEqual(payload['admin_notification'], 'submitted')
        self.assertEqual(payload['user_notification'], 'disabled')
        self.assertEqual(payload['recipient_mode'], 'admin')
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(scheduled[0][0], 'admin@example.com')
        self.assertIn('Ryan AI', scheduled[0][2])
