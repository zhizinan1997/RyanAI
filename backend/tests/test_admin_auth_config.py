import os
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

os.environ.setdefault('WEBUI_SECRET_KEY', 'test-secret-key')

from open_webui.routers import auths


class AdminAuthConfigRegressionTests(IsolatedAsyncioTestCase):
    async def test_ai_error_email_settings_are_returned_to_admin_ui(self):
        stored_values = {
            'notifications.ai_error_email.enabled': True,
            'notifications.ai_error_email.cooldown_seconds': 300,
            'notifications.ai_error_email.recipient_mode': 'admin_and_user',
            'ui.smtp.host': 'smtp.example.com',
            'ui.smtp.port': '465',
            'ui.smtp.username': 'sender@example.com',
            'ui.smtp.password': 'secret',
            'ui.smtp.sent_from': 'alerts@example.com',
        }

        with (
            patch.object(auths.Config, 'get_many', AsyncMock(return_value=stored_values)),
            patch.object(auths.Config, 'get', AsyncMock(return_value='')),
        ):
            result = await auths.get_admin_config_values()

        self.assertTrue(result['ENABLE_AI_ERROR_EMAIL_NOTIFICATION'])
        self.assertEqual(result['AI_ERROR_EMAIL_COOLDOWN_SECONDS'], 300)
        self.assertEqual(result['AI_ERROR_EMAIL_RECIPIENT_MODE'], 'admin_and_user')
        self.assertEqual(result['SMTP_HOST'], 'smtp.example.com')
        self.assertEqual(result['SMTP_USERNAME'], 'sender@example.com')

    def test_ai_error_email_settings_are_accepted_by_admin_config_model(self):
        fields = auths.AdminConfig.model_fields

        self.assertIn('ENABLE_AI_ERROR_EMAIL_NOTIFICATION', fields)
        self.assertIn('AI_ERROR_EMAIL_COOLDOWN_SECONDS', fields)
        self.assertIn('AI_ERROR_EMAIL_RECIPIENT_MODE', fields)
        self.assertIn('SMTP_HOST', fields)
        self.assertIn('SMTP_PASSWORD', fields)

