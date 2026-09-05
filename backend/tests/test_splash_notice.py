import os
import tempfile
from io import BytesIO
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

os.environ.setdefault('WEBUI_SECRET_KEY', 'test-secret-key')

from fastapi import HTTPException, UploadFile
from open_webui.routers import auths
from starlette.datastructures import Headers


def make_admin_config(**overrides):
    values = {
        'SHOW_ADMIN_DETAILS': False,
        'ADMIN_EMAIL': None,
        'WEBUI_URL': '',
        'ENABLE_SIGNUP': True,
        'ENABLE_API_KEYS': True,
        'ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS': False,
        'API_KEYS_ALLOWED_ENDPOINTS': '',
        'DEFAULT_USER_ROLE': 'pending',
        'DEFAULT_GROUP_ID': '',
        'DEFAULT_INTERFACE_SETTINGS': {},
        'JWT_EXPIRES_IN': '-1',
        'ENABLE_COMMUNITY_SHARING': True,
        'ENABLE_MESSAGE_RATING': True,
        'ENABLE_FOLDERS': True,
        'FOLDER_MAX_FILE_COUNT': None,
        'AUTOMATION_MAX_COUNT': None,
        'AUTOMATION_MIN_INTERVAL': None,
        'ENABLE_AUTOMATIONS': True,
        'ENABLE_CHANNELS': True,
        'CHANNEL_MODEL_RESPONSE_MODE': 'thread',
        'ENABLE_CALENDAR': True,
        'ENABLE_MEMORIES': True,
        'ENABLE_MEMORY_SYSTEM_CONTEXT': True,
        'ENABLE_NOTES': True,
        'ENABLE_USER_WEBHOOKS': True,
        'ENABLE_USER_STATUS': True,
        'PENDING_USER_OVERLAY_TITLE': None,
        'PENDING_USER_OVERLAY_CONTENT': None,
        'ENABLE_SPLASH_NOTICE': False,
        'SPLASH_NOTICE_TITLE': None,
        'SPLASH_NOTICE_CONTENT': None,
        'SPLASH_NOTICE_MEDIA_URL': None,
        'RESPONSE_WATERMARK': None,
    }
    values.update(overrides)
    return auths.AdminConfig(**values)


class SplashNoticeConfigTests(IsolatedAsyncioTestCase):
    async def test_admin_config_returns_splash_notice_fields_and_media_url(self):
        stored_values = {storage_key: f'value:{field}' for field, storage_key in auths.ADMIN_CONFIG_KEYS.items()}

        with (
            patch.object(auths.Config, 'get_many', AsyncMock(return_value=stored_values)),
            patch.object(auths.Config, 'get', AsyncMock(return_value='notice image.png')),
        ):
            result = await auths.get_admin_config_values()

        self.assertEqual(result['ENABLE_SPLASH_NOTICE'], 'value:ENABLE_SPLASH_NOTICE')
        self.assertEqual(result['SPLASH_NOTICE_TITLE'], 'value:SPLASH_NOTICE_TITLE')
        self.assertEqual(result['SPLASH_NOTICE_CONTENT'], 'value:SPLASH_NOTICE_CONTENT')
        self.assertEqual(
            result['SPLASH_NOTICE_MEDIA_URL'],
            '/api/v1/auths/admin/config/splash-notice/media/notice%20image.png',
        )

    async def test_update_admin_config_persists_splash_notice_fields(self):
        form = make_admin_config(
            ENABLE_SPLASH_NOTICE=True,
            SPLASH_NOTICE_TITLE='Maintenance',
            SPLASH_NOTICE_CONTENT='Back at **10:00**.',
        )
        upsert = AsyncMock()

        with (
            patch.object(auths.Config, 'upsert', upsert),
            patch.object(auths, 'get_admin_config_values', AsyncMock(return_value={'status': True})),
        ):
            result = await auths.update_admin_config(request=None, form_data=form, user=object())

        updates = upsert.await_args.args[0]
        self.assertTrue(updates['ui.splash_notice_enabled'])
        self.assertEqual(updates['ui.splash_notice_title'], 'Maintenance')
        self.assertEqual(updates['ui.splash_notice_content'], 'Back at **10:00**.')
        self.assertEqual(result, {'status': True})


class SplashNoticeMediaTests(IsolatedAsyncioTestCase):
    async def test_upload_replaces_previous_media_and_persists_new_file_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            media_dir = Path(temp_dir)
            previous = media_dir / 'previous.png'
            previous.write_bytes(b'old')
            upload = UploadFile(
                filename='announcement.png',
                file=BytesIO(b'new image'),
                headers=Headers({'content-type': 'image/png'}),
            )
            upsert = AsyncMock()

            with (
                patch.object(auths, 'SPLASH_NOTICE_MEDIA_DIR', media_dir),
                patch.object(auths.Config, 'get', AsyncMock(return_value=previous.name)),
                patch.object(auths.Config, 'upsert', upsert),
            ):
                result = await auths.upload_splash_notice_media(request=None, media=upload, user=object())

            new_file_name = upsert.await_args.args[0]['ui.splash_notice_media']
            self.assertFalse(previous.exists())
            self.assertEqual((media_dir / new_file_name).read_bytes(), b'new image')
            self.assertEqual(
                result['url'],
                f'/api/v1/auths/admin/config/splash-notice/media/{new_file_name}',
            )

    async def test_upload_rejects_unsupported_media(self):
        upload = UploadFile(
            filename='announcement.svg',
            file=BytesIO(b'<svg/>'),
            headers=Headers({'content-type': 'image/svg+xml'}),
        )

        with self.assertRaises(HTTPException) as context:
            await auths.upload_splash_notice_media(request=None, media=upload, user=object())

        self.assertEqual(context.exception.status_code, 400)

    async def test_delete_clears_config_and_removes_media(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            media_dir = Path(temp_dir)
            media_file = media_dir / 'notice.webp'
            media_file.write_bytes(b'image')
            upsert = AsyncMock()

            with (
                patch.object(auths, 'SPLASH_NOTICE_MEDIA_DIR', media_dir),
                patch.object(auths.Config, 'get', AsyncMock(return_value=media_file.name)),
                patch.object(auths.Config, 'upsert', upsert),
            ):
                result = await auths.delete_splash_notice_media(request=None, user=object())

            upsert.assert_awaited_once_with({'ui.splash_notice_media': ''})
            self.assertFalse(media_file.exists())
            self.assertEqual(result, {'status': True})

    async def test_get_only_serves_the_configured_media(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            media_dir = Path(temp_dir)
            media_file = media_dir / 'notice.gif'
            media_file.write_bytes(b'GIF89a')

            with (
                patch.object(auths, 'SPLASH_NOTICE_MEDIA_DIR', media_dir),
                patch.object(auths.Config, 'get', AsyncMock(return_value=media_file.name)),
            ):
                response = await auths.get_splash_notice_media(
                    request=None,
                    file_name=media_file.name,
                )
                with self.assertRaises(HTTPException) as context:
                    await auths.get_splash_notice_media(
                        request=None,
                        file_name='other.gif',
                    )

            self.assertEqual(Path(response.path).resolve(), media_file.resolve())
            self.assertEqual(context.exception.status_code, 404)
