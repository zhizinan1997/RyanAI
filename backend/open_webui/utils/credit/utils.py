import base64
import json
import math
from decimal import Decimal
from io import BytesIO
from typing import Optional, Union, Tuple

import httpx
from jsonpath_ng import parse as jsonpath_parse
from PIL import Image
from fastapi import HTTPException
from pydantic import BaseModel

from open_webui.config import (
    USAGE_CALCULATE_MINIMUM_COST,
    USAGE_CALCULATE_FEATURE_IMAGE_GEN_PRICE,
    USAGE_CALCULATE_FEATURE_CODE_EXECUTE_PRICE,
    USAGE_CALCULATE_FEATURE_WEB_SEARCH_PRICE,
    USAGE_CALCULATE_FEATURE_TOOL_SERVER_PRICE,
    CREDIT_NO_CREDIT_MSG,
)
from open_webui.models.config import Config
from open_webui.models.credits import AddCreditForm, Credits, SetCreditFormDetail
from open_webui.models.models import Models, ModelModel


def credit_config(key: str, default):
    value = Config.get_sync(key, default)
    return default if value is None else value


def get_model_price(
    model: Optional[ModelModel] = None,
    is_embedding: Optional[bool] = False,
) -> Tuple[
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
    Decimal,
]:
    """
    Returns
    - legacy token pricing fields (all zero)
    - price per successful call
    - minimum credit
    """
    # Models without saved per-call pricing are free. Pricing must be configured
    # explicitly for each model; token defaults are deliberately not used.
    if not model or not isinstance(model, ModelModel):
        return (
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
            Decimal(0),
        )
    # base model
    if model.base_model_id:
        base_model = Models.get_model_by_id_sync(model.base_model_id)
        if base_model:
            return get_model_price(base_model)
    # model price
    model_price = model.price or {}
    return (
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(0),
        Decimal(model_price.get('call_price', 0)),
        Decimal(model_price.get('minimum_credit', 0)),
    )


def get_feature_price(features: Union[set, list]) -> Decimal:
    if not features:
        return Decimal(0)
    price = Decimal(0)
    for feature in features:
        match feature:
            case 'image_generation':
                price += (
                    Decimal(
                        credit_config(
                            'credit.calculate.feature.image_gen_price',
                            USAGE_CALCULATE_FEATURE_IMAGE_GEN_PRICE,
                        )
                    )
                    / 1000
                    / 1000
                )
            case 'code_interpreter':
                price += (
                    Decimal(
                        credit_config(
                            'credit.calculate.feature.code_execute_price',
                            USAGE_CALCULATE_FEATURE_CODE_EXECUTE_PRICE,
                        )
                    )
                    / 1000
                    / 1000
                )
            case 'web_search':
                price += (
                    Decimal(
                        credit_config(
                            'credit.calculate.feature.web_search_price',
                            USAGE_CALCULATE_FEATURE_WEB_SEARCH_PRICE,
                        )
                    )
                    / 1000
                    / 1000
                )
            case 'direct_tool_servers':
                price += (
                    Decimal(
                        credit_config(
                            'credit.calculate.feature.tool_server_price',
                            USAGE_CALCULATE_FEATURE_TOOL_SERVER_PRICE,
                        )
                    )
                    / 1000
                    / 1000
                )
    return price


def check_feature_credit_by_user_id(
    user_id: str,
    feature: str,
    model_id: str | None = None,
) -> None:
    """Check balance before a standalone feature operation."""
    check_credit_by_user_id(
        user_id=user_id,
        form_data={
            'model': model_id or '',
            'messages': [{'role': 'user', 'content': feature}],
            'metadata': {'features_for_credit': {feature: True}},
        },
    )


def charge_feature_by_user_id(
    user_id: str,
    feature: str,
    model_id: str | None = None,
) -> Decimal:
    """Charge one successful standalone feature operation and log it."""
    amount = get_feature_price({feature})
    if amount <= 0:
        return Decimal(0)

    Credits.add_credit_by_user_id(
        AddCreditForm(
            user_id=user_id,
            amount=-amount,
            detail=SetCreditFormDetail(
                desc=f'updated by standalone {feature}',
                api_params={
                    'model': {
                        'id': model_id or feature,
                        'name': model_id or feature,
                    }
                },
                usage={
                    'total_price': float(amount),
                    'feature_price': float(amount),
                    'features': [feature],
                    'is_calculate': True,
                },
            ),
        )
    )
    return amount


def get_custom_price(body: dict) -> Decimal:
    """Calculate configured JSONPath-based fees before an upstream call."""
    custom_config = credit_config('credit.calculate.custom_price_config', '[]')
    if not custom_config or custom_config == '[]' or not isinstance(body, dict):
        return Decimal(0)

    try:
        configs = json.loads(custom_config)
    except Exception:
        return Decimal(0)

    if not isinstance(configs, list):
        return Decimal(0)

    total = 0
    for config in configs:
        if not isinstance(config, dict):
            continue
        try:
            path = config['path']
            cost = int(config['cost'])
            exists_check = bool(config['exists'])
            value = config.get('value')
            if not path or cost <= 0:
                continue

            matches = jsonpath_parse(path).find(body)
            if exists_check and matches:
                total += cost
            elif not exists_check and any(match.value == value for match in matches):
                total += cost
        except Exception:
            continue

    return Decimal(total) / 1000 / 1000


def is_free_request(model_price: list, form_data: dict) -> bool:
    is_free_model = sum(float(price) for price in model_price) <= 0

    metadata = form_data.get('metadata') or {}
    features = form_data.get('features') or metadata.get('features') or metadata.get('features_for_credit') or {}
    is_feature_free = get_feature_price({k for k, v in features.items() if v}) <= 0
    is_custom_fee_free = get_custom_price(form_data) <= 0

    return is_free_model and is_feature_free and is_custom_fee_free


def check_credit_by_user_id(user_id: str, form_data: dict, is_embedding: bool = False) -> None:
    # load model
    model_id = form_data.get('model') or form_data.get('model_id') or ''
    model = Models.get_model_by_id_sync(model_id)
    (
        prompt_price,
        completion_price,
        prompt_long_ctx_tokens,
        prompt_long_ctx_price,
        completion_long_ctx_tokens,
        completion_long_ctx_price,
        prompt_cache_price,
        prompt_long_ctx_cache_price,
        request_price,
        minimum_credit,
    ) = get_model_price(model, is_embedding=is_embedding)
    # check for free
    if is_free_request(
        model_price=[
            prompt_price,
            completion_price,
            prompt_long_ctx_price,
            completion_long_ctx_price,
            prompt_cache_price,
            prompt_long_ctx_cache_price,
            request_price,
        ],
        form_data=form_data,
    ):
        return
    # load credit
    metadata = form_data.get('metadata') or form_data
    credit = Credits.init_credit_by_user_id(user_id=user_id)
    # A fixed call price is known before the upstream request. Require enough
    # balance for that call (and any enabled feature fee) instead of checking
    # only the optional minimum-credit threshold.
    metadata_for_features = form_data.get('metadata') or {}
    feature_flags = (
        form_data.get('features')
        or metadata_for_features.get('features_for_credit')
        or metadata_for_features.get('features')
        or {}
    )
    feature_price = get_feature_price({key for key, enabled in feature_flags.items() if enabled})
    custom_price = get_custom_price(form_data)
    estimated_cost = max(
        (request_price if request_price > 0 else Decimal(0)) + feature_price + custom_price,
        Decimal(credit_config('credit.calculate.minimum_cost', USAGE_CALCULATE_MINIMUM_COST)),
    )
    required_credit = max(minimum_credit, estimated_cost)

    if credit is None or credit.credit < required_credit:
        no_credit_msg = credit_config('credit.no_credit_msg', CREDIT_NO_CREDIT_MSG)
        if isinstance(metadata, dict) and metadata:
            chat_id = metadata.get('chat_id')
            message_id = metadata.get('message_id') or metadata.get('id')
            if chat_id and message_id:
                from open_webui.models.chats import Chats

                Chats.upsert_message_to_chat_by_id_and_message_id(
                    chat_id,
                    message_id,
                    {'error': {'content': no_credit_msg}},
                )
        raise HTTPException(status_code=403, detail=no_credit_msg)


class ImageURL(BaseModel):
    url: str
    detail: str


def calculate_image_token(model_id: str, image: ImageURL) -> int:
    if not image or not image.url:
        return 0

    base_tokens = 85

    if image.detail == 'low':
        return 85

    if image.detail == 'auto' or not image.detail:
        image.detail = 'high'

    tile_tokens = 170

    if model_id.find('gpt-4o-mini') != -1:
        tile_tokens = 5667
        base_tokens = 2833

    if model_id.find('gemini') != -1 or model_id.find('claude') != -1:
        return 3 * base_tokens

    if image.url.startswith('http'):
        with httpx.Client(trust_env=True, timeout=60) as client:
            response = client.get(image.url)
        response.raise_for_status()
        image_data = base64.b64encode(response.content).decode('utf-8')
    else:
        if ',' in image.url:
            image_data = image.url.split(',', 1)[1]
        else:
            from open_webui.utils.files import get_image_base64_from_url

            image_data = get_image_base64_from_url(image.url) or image.url

    image_data = base64.b64decode(image_data.encode('utf-8'))
    image = Image.open(BytesIO(image_data))
    width, height = image.size

    short_side = width
    other_side = height

    scale = 1.0

    if height < short_side:
        short_side = height
        other_side = width

    if short_side > 768:
        scale = short_side / 768
        short_side = 768

    other_side = math.ceil(other_side / scale)

    tiles = (short_side + 511) / 512 * ((other_side + 511) / 512)

    return math.ceil(tiles * tile_tokens + base_tokens)


def check_amount(amount: float, amount_control: str) -> bool:
    if not amount_control:
        return True
    checks = amount_control.split(',')
    for check in checks:
        values = check.strip().split('-')
        if len(values) == 2:
            if float(values[0].strip()) <= amount <= float(values[1].strip()):
                return True
        if len(values) == 1:
            if float(values[0].strip()) == amount:
                return True
    return False
