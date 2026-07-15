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

    async def test_submits_redacted_email_and_suppresses_duplicate(self):
        values = {
            'notifications.ai_error_email.enabled': True,
            'auth.admin.email': 'admin@example.com',
            'ui.smtp.host': 'smtp.example.com',
            'ui.smtp.port': '465',
            'ui.smtp.username': 'sender@example.com',
            'ui.smtp.password': 'smtp-password',
            'notifications.ai_error_email.cooldown_seconds': 600,
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
        self.assertFalse(first['notification_suppressed'])
        self.assertEqual(second['admin_notification'], 'submitted')
        self.assertTrue(second['notification_suppressed'])
        self.assertEqual(len(scheduled), 1)
        receiver, _subject, body, _incident_id = scheduled[0]
        self.assertEqual(receiver, 'admin@example.com')
        self.assertNotIn('private user question', body)
        self.assertNotIn('sk-abcdefghijk', body)
        self.assertIn('Ryan', body)
        self.assertIn('chat-1', body)
