import json
import logging
import random
import time
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
from open_webui.models.credits import AddCreditForm, Credits, SetCreditFormDetail
from open_webui.models.lottery import LotteryDrawModel, LotteryDraws
from open_webui.models.users import Users
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.redis import get_redis_connection, get_sentinels_from_env

log = logging.getLogger(__name__)
log.setLevel(GLOBAL_LOG_LEVEL)

router = APIRouter()

PAGE_ITEM_COUNT = 30

# 78 张韦特塔罗编号,与前端 tarotCards.ts 一一对应
TAROT_CODES = [f'ar{i:02d}' for i in range(22)] + [
    suit + n
    for suit in ('wa', 'cu', 'pe', 'sw')
    for n in ('ac', '02', '03', '04', '05', '06', '07', '08', '09', '10', 'pa', 'kn', 'qu', 'ki')
]


####################
# Helpers
####################


def _tz(request: Request) -> ZoneInfo:
    name = getattr(request.app.state.config, 'LOTTERY_TIMEZONE', 'Asia/Shanghai') or 'Asia/Shanghai'
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo('Asia/Shanghai')


def _today(request: Request) -> str:
    return datetime.now(_tz(request)).strftime('%Y-%m-%d')


def _parse_rewards(request: Request):
    raw = getattr(request.app.state.config, 'TAROT_REWARD_CONFIG', '') or ''
    try:
        data = json.loads(raw)
        out = [
            (Decimal(str(x['amount'])), float(x['weight']))
            for x in data
            if float(x.get('weight', 0)) > 0
        ]
        return out or [(Decimal('1'), 1.0)]
    except Exception:
        log.warning('Invalid TAROT_REWARD_CONFIG, falling back to default')
        return [(Decimal('1'), 1.0)]


def _weighted_pick(rewards) -> Decimal:
    total = sum(w for _, w in rewards)
    r = random.uniform(0, total)
    upto = 0.0
    for amount, w in rewards:
        upto += w
        if r <= upto:
            return amount
    return rewards[0][0]


def _create_draw_record(
    request: Request,
    user_id: str,
    today: str,
    cards: list,
    desc: str,
    duplicate_detail: str,
) -> tuple[list, Decimal]:
    reward = _weighted_pick(_parse_rewards(request))

    saved = LotteryDraws.insert_draw(
        LotteryDrawModel(user_id=user_id, draw_date=today, reward=reward, cards=cards)
    )
    if saved is None:
        raise HTTPException(status_code=400, detail=duplicate_detail)

    Credits.add_credit_by_user_id(
        AddCreditForm(
            user_id=user_id,
            amount=reward,
            detail=SetCreditFormDetail(desc=desc, api_params={'cards': cards}),
        )
    )

    return cards, reward


####################
# User endpoints
####################


@router.get('/config')
async def get_lottery_config(request: Request, user=Depends(get_verified_user)):
    tarot_config_enabled = bool(getattr(request.app.state.config, 'ENABLE_TAROT_LOTTERY', False))
    checkin_config_enabled = bool(getattr(request.app.state.config, 'ENABLE_DAILY_CHECKIN', False))
    enabled = tarot_config_enabled and not checkin_config_enabled
    checkin_enabled = checkin_config_enabled and not tarot_config_enabled
    drawn = LotteryDraws.has_drawn(user.id, _today(request)) if enabled or checkin_enabled else False
    return {
        'enabled': enabled,
        'drawn_today': drawn,
        'checkin_enabled': checkin_enabled,
        'checked_in_today': drawn,
    }


@router.post('/draw')
async def draw(request: Request, user=Depends(get_verified_user)):
    if not getattr(request.app.state.config, 'ENABLE_TAROT_LOTTERY', False):
        raise HTTPException(status_code=400, detail='Lottery is not enabled')
    if getattr(request.app.state.config, 'ENABLE_DAILY_CHECKIN', False):
        raise HTTPException(status_code=400, detail='Lottery is not enabled')

    today = _today(request)
    if LotteryDraws.has_drawn(user.id, today):
        raise HTTPException(status_code=400, detail='Already drawn today')

    # concurrency control (best-effort; the DB unique index is the real guard)
    try:
        redis = get_redis_connection(
            redis_url=REDIS_URL,
            redis_sentinels=get_sentinels_from_env(REDIS_SENTINEL_HOSTS, REDIS_SENTINEL_PORT),
            redis_cluster=REDIS_CLUSTER,
        )
        if redis and not redis.set(f'lottery_draw:{user.id}:{today}', '1', nx=True, ex=30):
            raise HTTPException(status_code=400, detail='Too many requests')
    except HTTPException:
        raise
    except Exception:
        pass

    # server-authoritative draw: pick 3 distinct cards + orientation + weighted reward
    codes = random.sample(TAROT_CODES, 3)
    cards = [{'code': c, 'reversed': random.random() < 0.42} for c in codes]
    cards, reward = _create_draw_record(
        request, user.id, today, cards, 'tarot lottery reward', 'Already drawn today'
    )

    return {'cards': cards, 'reward': float(reward)}


@router.post('/checkin')
async def checkin(request: Request, user=Depends(get_verified_user)):
    if not getattr(request.app.state.config, 'ENABLE_DAILY_CHECKIN', False):
        raise HTTPException(status_code=400, detail='Check-in is not enabled')
    if getattr(request.app.state.config, 'ENABLE_TAROT_LOTTERY', False):
        raise HTTPException(status_code=400, detail='Check-in is not enabled')

    today = _today(request)
    if LotteryDraws.has_drawn(user.id, today):
        raise HTTPException(status_code=400, detail='Already checked in today')

    try:
        redis = get_redis_connection(
            redis_url=REDIS_URL,
            redis_sentinels=get_sentinels_from_env(REDIS_SENTINEL_HOSTS, REDIS_SENTINEL_PORT),
            redis_cluster=REDIS_CLUSTER,
        )
        if redis and not redis.set(f'lottery_checkin:{user.id}:{today}', '1', nx=True, ex=30):
            raise HTTPException(status_code=400, detail='Too many requests')
    except HTTPException:
        raise
    except Exception:
        pass

    _, reward = _create_draw_record(
        request, user.id, today, [], 'daily check-in reward', 'Already checked in today'
    )

    return {'reward': float(reward), 'checked_in_today': True}


@router.get('/history')
async def my_history(request: Request, user=Depends(get_verified_user)):
    draws = LotteryDraws.get_user_draws(user.id, limit=30)
    return [
        {
            'draw_date': d.draw_date,
            'reward': float(d.reward),
            'cards': d.cards,
            'type': 'checkin' if not d.cards else 'tarot',
            'created_at': d.created_at,
        }
        for d in draws
    ]


####################
# Admin endpoints
####################


class LotteryAdminConfigForm(BaseModel):
    ENABLE_TAROT_LOTTERY: bool = False
    ENABLE_DAILY_CHECKIN: bool = False
    TAROT_REWARD_CONFIG: str = ''
    LOTTERY_TIMEZONE: str = 'Asia/Shanghai'
    ENABLE_DAILY_CREDIT_RESET: bool = False
    DAILY_RESET_CREDIT: str = '3'


def _admin_config(request: Request) -> dict:
    c = request.app.state.config
    return {
        'ENABLE_TAROT_LOTTERY': bool(getattr(c, 'ENABLE_TAROT_LOTTERY', False)),
        'ENABLE_DAILY_CHECKIN': bool(getattr(c, 'ENABLE_DAILY_CHECKIN', False)),
        'TAROT_REWARD_CONFIG': getattr(c, 'TAROT_REWARD_CONFIG', ''),
        'LOTTERY_TIMEZONE': getattr(c, 'LOTTERY_TIMEZONE', 'Asia/Shanghai'),
        'ENABLE_DAILY_CREDIT_RESET': bool(getattr(c, 'ENABLE_DAILY_CREDIT_RESET', False)),
        'DAILY_RESET_CREDIT': getattr(c, 'DAILY_RESET_CREDIT', '3'),
    }


@router.get('/admin/config')
async def get_admin_lottery_config(request: Request, user=Depends(get_admin_user)):
    return _admin_config(request)


@router.post('/admin/config')
async def set_admin_lottery_config(
    request: Request, form: LotteryAdminConfigForm, user=Depends(get_admin_user)
):
    if form.ENABLE_TAROT_LOTTERY and form.ENABLE_DAILY_CHECKIN:
        raise HTTPException(status_code=400, detail='Tarot lottery and daily check-in cannot both be enabled')

    # validate reward config JSON
    try:
        data = json.loads(form.TAROT_REWARD_CONFIG or '[]')
        assert isinstance(data, list) and len(data) > 0
        for x in data:
            assert float(x['amount']) >= 0
            assert float(x['weight']) >= 0
        assert sum(float(x['weight']) for x in data) > 0
    except Exception:
        raise HTTPException(
            status_code=400, detail='Invalid reward config: expect [{"amount":N,"weight":W}, ...] with weight sum > 0'
        )
    # validate timezone
    try:
        ZoneInfo(form.LOTTERY_TIMEZONE or 'Asia/Shanghai')
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid timezone')
    # validate reset credit
    try:
        Decimal(str(form.DAILY_RESET_CREDIT))
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid daily reset credit')

    c = request.app.state.config
    c.ENABLE_TAROT_LOTTERY = form.ENABLE_TAROT_LOTTERY
    c.ENABLE_DAILY_CHECKIN = form.ENABLE_DAILY_CHECKIN
    c.TAROT_REWARD_CONFIG = form.TAROT_REWARD_CONFIG
    c.LOTTERY_TIMEZONE = form.LOTTERY_TIMEZONE
    c.ENABLE_DAILY_CREDIT_RESET = form.ENABLE_DAILY_CREDIT_RESET
    c.DAILY_RESET_CREDIT = str(form.DAILY_RESET_CREDIT)
    return _admin_config(request)


@router.get('/admin/draws')
async def list_lottery_draws(
    request: Request,
    page: Optional[int] = 1,
    keyword: Optional[str] = None,
    user=Depends(get_admin_user),
):
    page = page or 1
    limit = PAGE_ITEM_COUNT
    offset = (page - 1) * limit
    total, draws = LotteryDraws.get_draws(keyword=keyword, offset=offset, limit=limit)

    # resolve user display info
    name_map = {}
    for uid in {d.user_id for d in draws}:
        try:
            u = await Users.get_user_by_id(uid)
            if u:
                name_map[uid] = {'name': u.name, 'email': u.email}
        except Exception:
            pass

    items = [
        {
            'id': d.id,
            'user_id': d.user_id,
            'name': name_map.get(d.user_id, {}).get('name', d.user_id),
            'email': name_map.get(d.user_id, {}).get('email', ''),
            'draw_date': d.draw_date,
            'reward': float(d.reward),
            'cards': d.cards,
            'type': 'checkin' if not d.cards else 'tarot',
            'created_at': d.created_at,
        }
        for d in draws
    ]
    return {'total': total, 'page': page, 'limit': limit, 'items': items}
