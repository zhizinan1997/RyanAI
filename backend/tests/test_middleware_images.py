from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from open_webui.utils.middleware import convert_url_images_to_base64


class ConvertUrlImagesToBase64Tests(IsolatedAsyncioTestCase):
    async def test_unresolved_file_id_is_removed(self):
        form_data = {
            'messages': [
                {
                    'content': [
                        {'type': 'text', 'text': 'continue'},
                        {'type': 'image_url', 'image_url': {'url': 'stale-file-id'}},
                    ]
                }
            ]
        }

        with patch(
            'open_webui.utils.middleware.get_image_base64_from_url',
            new=AsyncMock(return_value=None),
        ):
            result = await convert_url_images_to_base64(form_data)

        self.assertEqual(
            result['messages'][0]['content'],
            [{'type': 'text', 'text': 'continue'}],
        )

    async def test_unresolved_remote_url_is_preserved(self):
        image = {'type': 'image_url', 'image_url': {'url': 'https://example.test/image.png'}}
        form_data = {'messages': [{'content': [image]}]}

        with patch(
            'open_webui.utils.middleware.get_image_base64_from_url',
            new=AsyncMock(return_value=None),
        ):
            result = await convert_url_images_to_base64(form_data)

        self.assertEqual(result['messages'][0]['content'], [image])

