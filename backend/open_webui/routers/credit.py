import datetime
import logging
from collections import defaultdict
from decimal import Decimal
from typing import Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from open_webui.env import GLOBAL_LOG_LEVEL
from open_webui.models.chat_messages import ChatMessages, get_usage, _normalize_timestamp
from open_webui.models.chats import Chats
from open_webui.models.credits import (
    Credits,
    CreditLogSimpleModel,
    CreditLogs,
)
from open_webui.models.models import ModelForm, Models, ModelPriceForm
from open_webui.models.users import UserModel, Users
from open_webui.utils.auth import get_verified_user, get_admin_user
from open_webui.utils.models import get_all_models

log = logging.getLogger(__name__)
log.setLevel(GLOBAL_LOG_LEVEL)

router = APIRouter()

PAGE_ITEM_COUNT = 30


@router.get('/logs', response_model=list[CreditLogSimpleModel])
async def list_credit_logs(
    page: Optional[int] = None, user: UserModel = Depends(get_verified_user)
) -> list[CreditLogSimpleModel]:
    if page:
        limit = PAGE_ITEM_COUNT
        offset = (page - 1) * limit
        return CreditLogs.get_credit_log_by_page(user_ids=[user.id], offset=offset, limit=limit)
    else:
        return CreditLogs.get_credit_log_by_page(user_ids=[user.id], offset=0, limit=10)


class DeleteLogsForm(BaseModel):
    timestamp: int = Field(gt=0)


class DeleteLogsResponse(BaseModel):
    affect_rows: int


@router.delete('/logs')
async def delete_credit_logs(form_data: DeleteLogsForm, _: UserModel = Depends(get_admin_user)) -> DeleteLogsResponse:
    return DeleteLogsResponse(affect_rows=CreditLogs.delete_log_by_timestamp(form_data.timestamp))


@router.get('/all_logs')
async def get_all_logs(
    query: Optional[str] = None,
    page: Optional[int] = None,
    limit: Optional[int] = None,
    _: UserModel = Depends(get_admin_user),
):
    # init params
    page = page or 1
    limit = limit or PAGE_ITEM_COUNT
    offset = (page - 1) * limit
    # query users
    users = await Users.get_users(filter={'query': query})
    user_map = {user.id: user.name for user in users['users']}
    if query and not user_map:
        return {'total': 0, 'results': []}
    # query db
    user_ids = list(user_map.keys()) if query else None
    results = CreditLogs.get_credit_log_by_page(user_ids=user_ids, offset=offset, limit=limit)
    total = CreditLogs.count_credit_log(user_ids=user_ids)
    # add username to results
    for result in results:
        setattr(result, 'username', user_map.get(result.user_id, ''))
    return {'total': total, 'results': results}


@router.get('/models/price')
async def get_model_price(request: Request, user: UserModel = Depends(get_admin_user)):
    # no info means not saved in db, which cannot be updated
    # preset model is always using base model's price
    return {
        model['id']: model.get('info', {}).get('price') or {}
        for model in await get_all_models(request, user)
        if model.get('info') and not model.get('info', {}).get('base_model_id')
    }
@router.put('/models/price')
async def update_model_price(form_data: dict[str, dict], _: UserModel = Depends(get_admin_user)):
    for model_id, price in form_data.items():
        model = await Models.get_model_by_id(id=model_id)
        if not model:
            continue
        model_data = model.model_dump()
        model_data['price'] = ModelPriceForm.model_validate(price).model_dump() if price else None
        await Models.update_model_by_id(id=model_id, model=ModelForm.model_validate(model_data))
    return f'success update price for {len(form_data)} models'


class StatisticRequest(BaseModel):
    start_time: int
    end_time: int
    query: Optional[str] = None


class MyUsagePeriod(BaseModel):
    start_time: int
    end_time: int
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    conversation_count: int = 0
    credit_used: float = 0


class UserLeaderboardEntry(BaseModel):
    rank: int
    display_name: str
    conversation_count: int = 0
    total_tokens: int = 0
    is_current_user: bool = False


class UserLeaderboardPeriod(BaseModel):
    top: list[UserLeaderboardEntry] = Field(default_factory=list)
    current_user: Optional[UserLeaderboardEntry] = None


class ModelLeaderboardEntry(BaseModel):
    rank: int
    model_name: str
    logo_url: str = '/favicon.png'
    call_count: int = 0


class MyUsageSummaryResponse(BaseModel):
    credit: float = 0
    periods: dict[str, MyUsagePeriod]
    user_leaderboards: dict[str, UserLeaderboardPeriod]
    model_leaderboards: dict[str, list[ModelLeaderboardEntry]]


def _mask_display_name(name: Optional[str]) -> str:
    chars = list((name or '').strip())
    if not chars:
        return '*'
    if len(chars) == 1:
        return '*'
    if len(chars) == 2:
        return f'{chars[0]}*'
    return f'{chars[0]}{"*" * (len(chars) - 2)}{chars[-1]}'


def _model_logo_url(model_id: str) -> str:
    return f'/api/v1/models/model/profile/image?id={quote(model_id, safe="")}'


async def _build_user_leaderboard(
    current_user_id: str,
    usage_by_user: dict[str, dict[str, int]],
) -> UserLeaderboardPeriod:
    user_ids = list(usage_by_user.keys())
    users = await Users.get_users_by_user_ids(user_ids) if user_ids else []
    user_map = {user.id: user for user in users}

    sorted_user_ids = sorted(
        user_ids,
        key=lambda uid: (
            -int(usage_by_user[uid].get('total_tokens') or 0),
            -int(usage_by_user[uid].get('conversation_count') or 0),
            (user_map.get(uid).name if user_map.get(uid) else uid).lower(),
            uid,
        ),
    )

    entries = []
    for rank, user_id in enumerate(sorted_user_ids, start=1):
        usage = usage_by_user[user_id]
        user = user_map.get(user_id)
        entries.append(
            UserLeaderboardEntry(
                rank=rank,
                display_name=_mask_display_name(user.name if user else user_id),
                conversation_count=int(usage.get('conversation_count') or 0),
                total_tokens=int(usage.get('total_tokens') or 0),
                is_current_user=user_id == current_user_id,
            )
        )

    current_user_entry = next((entry for entry in entries if entry.is_current_user), None)
    return UserLeaderboardPeriod(top=entries[:10], current_user=current_user_entry)


async def _build_model_leaderboard(call_counts_by_model: dict[str, int]) -> list[ModelLeaderboardEntry]:
    sorted_model_ids = sorted(
        call_counts_by_model.keys(),
        key=lambda model_id: (-int(call_counts_by_model[model_id] or 0), model_id),
    )[:5]

    models = await Models.get_models_by_ids(sorted_model_ids) if sorted_model_ids else []
    model_map = {model.id: model for model in models}

    entries = []
    for rank, model_id in enumerate(sorted_model_ids, start=1):
        model = model_map.get(model_id)
        entries.append(
            ModelLeaderboardEntry(
                rank=rank,
                model_name=model.name if model else model_id,
                logo_url=_model_logo_url(model_id),
                call_count=int(call_counts_by_model[model_id] or 0),
            )
        )

    return entries


def _get_usage_timezone(timezone: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or 'Asia/Shanghai')
    except ZoneInfoNotFoundError:
        return ZoneInfo('Asia/Shanghai')


def _to_epoch(dt: datetime.datetime) -> int:
    return int(dt.astimezone(datetime.timezone.utc).timestamp())


def _usage_period_ranges(timezone: Optional[str]) -> dict[str, tuple[int, int]]:
    tz = _get_usage_timezone(timezone)
    now = datetime.datetime.now(tz)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - datetime.timedelta(days=day_start.weekday())
    month_start = day_start.replace(day=1)

    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)

    ranges = {
        'day': (day_start, day_start + datetime.timedelta(days=1)),
        'week': (week_start, week_start + datetime.timedelta(days=7)),
        'month': (month_start, next_month_start),
    }
    return {key: (_to_epoch(start), _to_epoch(end)) for key, (start, end) in ranges.items()}


def _credit_used_for_period(user_id: str, start_time: int, end_time: int) -> float:
    credit_used = Decimal('0')
    for log_item in CreditLogs.get_log_by_time(start_time, end_time, [user_id]):
        usage = _usage_from_credit_log_detail(log_item.detail)
        total_price = _decimal_usage_value(usage, 'total_price', 'total_cost')
        if total_price is not None:
            credit_used += total_price
    return float(credit_used)


def _usage_from_credit_log_detail(detail) -> dict:
    if not detail:
        return {}

    if isinstance(detail, dict):
        usage = detail.get('usage') or {}
    else:
        usage = getattr(detail, 'usage', None) or {}

    if hasattr(usage, 'model_dump'):
        return usage.model_dump()
    return usage if isinstance(usage, dict) else {}


def _int_usage_value(usage: dict, *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if value is not None:
            return int(value)
    return 0


def _decimal_usage_value(usage: dict, *keys: str) -> Optional[Decimal]:
    for key in keys:
        value = usage.get(key)
        if value is not None:
            return Decimal(str(value))
    return None


def _usage_summary_from_credit_logs(user_id: str, start_time: int, end_time: int) -> dict[str, int | float]:
    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    credit_used = Decimal('0')

    for log_item in CreditLogs.get_log_by_time(start_time, end_time, [user_id]):
        usage = _usage_from_credit_log_detail(log_item.detail)
        if not usage:
            continue

        message_input = _int_usage_value(usage, 'input_tokens', 'prompt_tokens')
        message_output = _int_usage_value(usage, 'output_tokens', 'completion_tokens')
        message_total = _int_usage_value(usage, 'total_tokens') or message_input + message_output

        input_tokens += message_input
        output_tokens += message_output
        total_tokens += message_total

        total_price = _decimal_usage_value(usage, 'total_price', 'total_cost')
        if total_price is not None:
            credit_used += total_price

    return {
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'total_tokens': total_tokens,
        'credit_used': float(credit_used),
    }
async def _legacy_usage_summary_by_user(
    user_id: str,
    start_time: int,
    end_time: int,
    db: Optional[AsyncSession] = None,
) -> dict[str, int | float]:
    chats = await Chats.get_chats_by_user_id(user_id=user_id, skip=0, limit=None, db=db)

    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    conversation_count = 0
    credit_used = Decimal('0')

    for chat in chats.items:
        history_messages = (chat.chat or {}).get('history', {}).get('messages', {}) or {}
        for message in history_messages.values():
            if message.get('role') != 'assistant':
                continue

            timestamp = message.get('timestamp') or message.get('created_at') or 0
            if not timestamp:
                continue

            normalized_timestamp = int(_normalize_timestamp(int(timestamp)))
            if normalized_timestamp < start_time or normalized_timestamp >= end_time:
                continue

            conversation_count += 1

            usage = get_usage(message) or {}
            message_input = int(usage.get('input_tokens') or usage.get('prompt_tokens') or 0)
            message_output = int(usage.get('output_tokens') or usage.get('completion_tokens') or 0)

            input_tokens += message_input
            output_tokens += message_output
            total_tokens += int(usage.get('total_tokens') or (message_input + message_output))

            total_price = usage.get('total_price') if usage.get('total_price') is not None else usage.get('total_cost')
            if total_price is not None:
                credit_used += Decimal(str(total_price))

    return {
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'total_tokens': total_tokens,
        'conversation_count': conversation_count,
        'credit_used': float(credit_used),
    }
@router.get('/my/usage-summary', response_model=MyUsageSummaryResponse)
async def get_my_usage_summary(user: UserModel = Depends(get_verified_user)):
    credit = Credits.init_credit_by_user_id(user.id)
    periods: dict[str, MyUsagePeriod] = {}
    user_leaderboards: dict[str, UserLeaderboardPeriod] = {}
    model_leaderboards: dict[str, list[ModelLeaderboardEntry]] = {}

    for period_key, (start_time, end_time) in _usage_period_ranges(user.timezone).items():
        token_usage = await ChatMessages.get_usage_summary_by_user(user.id, start_time, end_time)
        log_usage = _usage_summary_from_credit_logs(user.id, start_time, end_time)

        if token_usage['total_tokens'] == 0 or token_usage['conversation_count'] == 0:
            legacy_usage = await _legacy_usage_summary_by_user(user.id, start_time, end_time)
            if token_usage['total_tokens'] == 0 and legacy_usage['total_tokens'] > 0:
                token_usage.update(
                    {
                        'input_tokens': legacy_usage['input_tokens'],
                        'output_tokens': legacy_usage['output_tokens'],
                        'total_tokens': legacy_usage['total_tokens'],
                    }
                )
            if token_usage['conversation_count'] == 0 and legacy_usage['conversation_count'] > 0:
                token_usage['conversation_count'] = legacy_usage['conversation_count']

        if token_usage['total_tokens'] == 0 and log_usage['total_tokens'] > 0:
            token_usage.update(
                {
                    'input_tokens': log_usage['input_tokens'],
                    'output_tokens': log_usage['output_tokens'],
                    'total_tokens': log_usage['total_tokens'],
                }
            )

        periods[period_key] = MyUsagePeriod(
            start_time=start_time,
            end_time=end_time,
            input_tokens=token_usage['input_tokens'],
            output_tokens=token_usage['output_tokens'],
            total_tokens=token_usage['total_tokens'],
            conversation_count=token_usage['conversation_count'],
            credit_used=log_usage['credit_used'],
        )

        usage_by_user = await ChatMessages.get_usage_leaderboard_by_user(start_time, end_time)
        user_leaderboards[period_key] = await _build_user_leaderboard(user.id, usage_by_user)

        model_call_counts = await ChatMessages.get_model_call_count_leaderboard(start_time, end_time)
        model_leaderboards[period_key] = await _build_model_leaderboard(model_call_counts)

    return MyUsageSummaryResponse(
        credit=float(credit.credit or 0),
        periods=periods,
        user_leaderboards=user_leaderboards,
        model_leaderboards=model_leaderboards,
    )


@router.post('/statistics')
async def get_statistics(form_data: StatisticRequest, _: UserModel = Depends(get_admin_user)):
    # query user id
    user_ids = []
    if form_data.query:
        users = (await Users.get_users(filter={'query': form_data.query}))['users']
        user_map = {user.id: user.name for user in users}
        user_ids = list(user_map.keys())
        if not user_ids:
            return {
                'total_tokens': 0,
                'total_credit': 0,
                'model_cost_pie': [],
                'model_token_pie': [],
                'user_cost_pie': [],
                'user_token_pie': [],
            }
    else:
        users = (await Users.get_users())['users']
        user_map = {user.id: user.name for user in users}

    # load credit data
    logs = CreditLogs.get_log_by_time(form_data.start_time, form_data.end_time, user_ids)

    # build graph data
    total_tokens = 0
    total_credit = 0
    model_cost_pie = defaultdict(int)
    model_token_pie = defaultdict(int)
    user_cost_pie = defaultdict(int)
    user_token_pie = defaultdict(int)
    for log in logs:
        if not log.detail.usage or log.detail.usage.total_price is None:
            continue

        model = log.detail.api_params.model
        if not model:
            continue

        total_tokens += log.detail.usage.total_tokens
        total_credit += log.detail.usage.total_price

        model_key = log.detail.api_params.model.id
        model_cost_pie[model_key] += log.detail.usage.total_price
        model_token_pie[model_key] += log.detail.usage.total_tokens

        user_key = f'{log.user_id}:{user_map.get(log.user_id, log.user_id)}'
        user_cost_pie[user_key] += log.detail.usage.total_price
        user_token_pie[user_key] += log.detail.usage.total_tokens

    # response
    return {
        'total_tokens': total_tokens,
        'total_credit': total_credit,
        'model_cost_pie': [{'name': model, 'value': total} for model, total in model_cost_pie.items()],
        'model_token_pie': [{'name': model, 'value': total} for model, total in model_token_pie.items()],
        'user_cost_pie': [{'name': user.split(':', 1)[1], 'value': total} for user, total in user_cost_pie.items()],
        'user_token_pie': [{'name': user.split(':', 1)[1], 'value': total} for user, total in user_token_pie.items()],
    }
