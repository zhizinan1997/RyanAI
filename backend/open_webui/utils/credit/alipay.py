import logging
from urllib.parse import unquote

from alipay.aop.api.AlipayClientConfig import AlipayClientConfig
from alipay.aop.api.DefaultAlipayClient import DefaultAlipayClient
from alipay.aop.api.domain.AlipayTradePrecreateModel import AlipayTradePrecreateModel
from alipay.aop.api.request.AlipayTradePrecreateRequest import (
    AlipayTradePrecreateRequest,
)
from alipay.aop.api.response.AlipayTradePrecreateResponse import (
    AlipayTradePrecreateResponse,
)
from alipay.aop.api.util.SignatureUtils import verify_with_rsa

from open_webui.config import (
    ALIPAY_SERVER_URL,
    ALIPAY_APP_ID,
    ALIPAY_APP_PRIVATE_KEY,
    ALIPAY_ALIPAY_PUBLIC_KEY,
    ALIPAY_AMOUNT_CONTROL,
    WEBUI_NAME,
    ALIPAY_CALLBACK_HOST,
    ALIPAY_PRODUCT_CODE,
)
from open_webui.env import GLOBAL_LOG_LEVEL
from open_webui.utils.credit.utils import check_amount, credit_config

logger = logging.getLogger(__name__)
logger.setLevel(GLOBAL_LOG_LEVEL)


def _cfg(key: str, default: str) -> str:
    return str(credit_config(key, default) or '')


class AlipayClient:
    """
    alipay client
    """

    def __init__(self):
        self._client_config = AlipayClientConfig()
        self._client_config.server_url = _cfg('credit.alipay.server_url', ALIPAY_SERVER_URL)
        self._client_config.app_id = _cfg('credit.alipay.app_id', ALIPAY_APP_ID)
        self._client_config.app_private_key = _cfg('credit.alipay.app_private_key', ALIPAY_APP_PRIVATE_KEY)
        self._client_config.alipay_public_key = _cfg(
            'credit.alipay.alipay_public_key',
            ALIPAY_ALIPAY_PUBLIC_KEY,
        )
        self._client = DefaultAlipayClient(self._client_config, logger)

    def verify(self, payload: dict) -> bool:
        sign = payload.get('sign', '')
        if not sign:
            return False
        payload_filtered = [f'{k}={unquote(v)}' for k, v in payload.items() if k not in ['sign', 'sign_type']]
        payload_filtered.sort()
        payload_content = '&'.join(payload_filtered)
        try:
            return verify_with_rsa(
                self._client_config.alipay_public_key,
                payload_content.encode(self._client_config.charset),
                sign,
            )
        except Exception as err:
            logger.error('alipay verify error: %s', err)
            return False

    async def create_trade(self, out_trade_no: str, amount: float) -> dict:
        # check for amount
        amount_control = _cfg('credit.alipay.amount_control', ALIPAY_AMOUNT_CONTROL)
        if not check_amount(amount, amount_control):
            return {
                'code': -1,
                'msg': f'amount invalid, allows {" ".join(amount_control.split(","))}',
            }
        # build request
        request_model = AlipayTradePrecreateModel()
        request_model.out_trade_no = out_trade_no
        request_model.total_amount = f'{amount:.2f}'
        request_model.subject = f'{WEBUI_NAME} Credit'
        product_code = _cfg('credit.alipay.product_code', ALIPAY_PRODUCT_CODE)
        if product_code:
            request_model.product_code = product_code
        request = AlipayTradePrecreateRequest(biz_model=request_model)
        request.notify_url = f'{_cfg("credit.alipay.callback_host", ALIPAY_CALLBACK_HOST).rstrip("/")}/api/v1/credit/callback/alipay'
        # do request
        try:
            response_content = self._client.execute(request)
            response = AlipayTradePrecreateResponse()
            response.parse_response_content(response_content)
            if response.is_success():
                return {
                    'code': 1,
                    'trade_no': response.out_trade_no,
                    'qrcode': response.qr_code,
                }
            return {'code': -1, 'msg': str(response_content)}
        except Exception as err:
            logger.exception('alipay create trade error: %s', err)
            return {'code': -1, 'msg': str(err)}
