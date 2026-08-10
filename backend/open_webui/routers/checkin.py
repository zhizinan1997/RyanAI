import json
import logging
from datetime import datetime
from decimal import Decimal
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from open_webui.env import (
    GLOBAL_LOG_LEVEL,
    REDIS_CLUSTER,
    REDIS_SENTINEL_HOSTS,
    REDIS_SENTINEL_PORT,
    REDIS_URL,
)
from open_webui.models.config import Config
from open_webui.models.checkin import CheckinRecordModel, CheckinRecords
from open_webui.models.credits import AddCreditForm, Credits, SetCreditFormDetail
from open_webui.models.users import Users
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.redis import get_redis_connection, get_sentinels_from_env

log = logging.getLogger(__name__)
log.setLevel(GLOBAL_LOG_LEVEL)

router = APIRouter()
PAGE_ITEM_COUNT = 30


def _tz(request: Request) -> ZoneInfo:
    name = Config.get_sync('lottery.timezone', 'Asia/Shanghai') or 'Asia/Shanghai'
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo('Asia/Shanghai')


def _today(request: Request) -> str:
    return datetime.now(_tz(request)).strftime('%Y-%m-%d')


def _parse_rewards() -> list[tuple[Decimal, float]]:
    raw = Config.get_sync('lottery.reward_config', '') or ''
    try:
        data = json.loads(raw)
        rewards = [
            (Decimal(str(item['amount'])), float(item['weight']))
            for item in data
            if float(item.get('weight', 0)) > 0
        ]
        return rewards or [(Decimal('1'), 1.0)]
    except Exception:
        log.warning('Invalid daily check-in reward config, falling back to default')
        return [(Decimal('1'), 1.0)]


def _weighted_pick(rewards: list[tuple[Decimal, float]]) -> Decimal:
    import random

    total = sum(weight for _, weight in rewards)
    value = random.uniform(0, total)
    cumulative = 0.0
    for amount, weight in rewards:
        cumulative += weight
        if value <= cumulative:
            return amount
    return rewards[0][0]


def _create_checkin_record(
    request: Request, user_id: str, today: str, duplicate_detail: str
) -> Decimal:
    reward = _weighted_pick(_parse_rewards())
    saved = CheckinRecords.insert(
        CheckinRecordModel(user_id=user_id, checkin_date=today, reward=reward)
    )
    if saved is None:
        raise HTTPException(status_code=400, detail=duplicate_detail)

    Credits.add_credit_by_user_id(
        AddCreditForm(
            user_id=user_id,
            amount=reward,
            detail=SetCreditFormDetail(
                desc='daily check-in reward',
                api_params={'checkin_date': today},
            ),
        )
    )
    return reward


@router.get('/config')
async def get_checkin_config(request: Request, user=Depends(get_verified_user)):
    enabled = bool(await Config.get('lottery.checkin.enable', False))
    checked_in = CheckinRecords.has_checked_in(user.id, _today(request)) if enabled else False
    return {
        'checkin_enabled': enabled,
        'checked_in_today': checked_in,
    }


@router.post('/checkin')
async def checkin(request: Request, user=Depends(get_verified_user)):
    if not await Config.get('lottery.checkin.enable', False):
        raise HTTPException(status_code=400, detail='Check-in is not enabled')

    today = _today(request)
    if CheckinRecords.has_checked_in(user.id, today):
        raise HTTPException(status_code=400, detail='Already checked in today')

    try:
        redis = get_redis_connection(
            redis_url=REDIS_URL,
            redis_sentinels=get_sentinels_from_env(REDIS_SENTINEL_HOSTS, REDIS_SENTINEL_PORT),
            redis_cluster=REDIS_CLUSTER,
        )
        if redis and not redis.set(f'checkin:{user.id}:{today}', '1', nx=True, ex=30):
            raise HTTPException(status_code=400, detail='Too many requests')
    except HTTPException:
        raise
    except Exception:
        pass

    reward = _create_checkin_record(request, user.id, today, 'Already checked in today')
    return {'reward': float(reward), 'checked_in_today': True}


@router.get('/history')
async def my_history(user=Depends(get_verified_user)):
    return [
        {
            'checkin_date': record.checkin_date,
            'reward': float(record.reward),
            'type': 'checkin',
            'created_at': record.created_at,
        }
        for record in CheckinRecords.get_user_records(user.id, limit=30)
    ]


class CheckinAdminConfigForm(BaseModel):
    ENABLE_DAILY_CHECKIN: bool = False
    DAILY_CHECKIN_REWARD_CONFIG: str = ''
    CHECKIN_TIMEZONE: str = 'Asia/Shanghai'
    ENABLE_DAILY_CREDIT_RESET: bool = False
    DAILY_RESET_CREDIT: str = '3'


async def _admin_config() -> dict:
    config = await Config.get_many(
        'lottery.checkin.enable',
        'lottery.reward_config',
        'lottery.timezone',
        'lottery.daily_reset.enable',
        'lottery.daily_reset.credit',
    )
    return {
        'ENABLE_DAILY_CHECKIN': bool(config.get('lottery.checkin.enable', False)),
        'DAILY_CHECKIN_REWARD_CONFIG': config.get('lottery.reward_config', ''),
        'CHECKIN_TIMEZONE': config.get('lottery.timezone', 'Asia/Shanghai'),
        'ENABLE_DAILY_CREDIT_RESET': bool(config.get('lottery.daily_reset.enable', False)),
        'DAILY_RESET_CREDIT': config.get('lottery.daily_reset.credit', '3'),
    }


@router.get('/admin/config')
async def get_admin_checkin_config(user=Depends(get_admin_user)):
    return await _admin_config()


@router.post('/admin/config')
async def set_admin_checkin_config(
    form: CheckinAdminConfigForm, user=Depends(get_admin_user)
):
    try:
        data = json.loads(form.DAILY_CHECKIN_REWARD_CONFIG or '[]')
        assert isinstance(data, list) and len(data) > 0
        for item in data:
            assert float(item['amount']) >= 0
            assert float(item['weight']) >= 0
        assert sum(float(item['weight']) for item in data) > 0
    except Exception:
        raise HTTPException(
            status_code=400,
            detail='Invalid reward config: expect [{"amount":N,"weight":W}, ...] with weight sum > 0',
        )

    try:
        ZoneInfo(form.CHECKIN_TIMEZONE or 'Asia/Shanghai')
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid timezone')

    try:
        reset_credit = Decimal(str(form.DAILY_RESET_CREDIT))
        if reset_credit < 0:
            raise ValueError('daily reset credit must be non-negative')
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid daily reset credit')

    await Config.upsert(
        {
            'lottery.checkin.enable': form.ENABLE_DAILY_CHECKIN,
            'lottery.reward_config': form.DAILY_CHECKIN_REWARD_CONFIG,
            'lottery.timezone': form.CHECKIN_TIMEZONE,
            'lottery.daily_reset.enable': form.ENABLE_DAILY_CREDIT_RESET,
            'lottery.daily_reset.credit': str(form.DAILY_RESET_CREDIT),
        }
    )
    return await _admin_config()


@router.get('/admin/records')
async def list_checkin_records(
    page: Optional[int] = 1,
    keyword: Optional[str] = None,
    user=Depends(get_admin_user),
):
    page = page or 1
    limit = PAGE_ITEM_COUNT
    offset = (page - 1) * limit
    total, records = CheckinRecords.get_records(keyword=keyword, offset=offset, limit=limit)

    name_map = {}
    for user_id in {record.user_id for record in records}:
        try:
            account = await Users.get_user_by_id(user_id)
            if account:
                name_map[user_id] = {'name': account.name, 'email': account.email}
        except Exception:
            pass

    items = [
        {
            'id': record.id,
            'user_id': record.user_id,
            'name': name_map.get(record.user_id, {}).get('name', record.user_id),
            'email': name_map.get(record.user_id, {}).get('email', ''),
            'checkin_date': record.checkin_date,
            'reward': float(record.reward),
            'type': 'checkin',
            'created_at': record.created_at,
        }
        for record in records
    ]
    return {'total': total, 'page': page, 'limit': limit, 'items': items}
