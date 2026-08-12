"""Deterministic, sticky load-aware scheduler for bot gateway connections."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Iterable, Literal

SchedulerMode = Literal['static', 'shadow', 'auto']
MOVE_COOLDOWN_SECONDS = 30 * 60


@dataclass(frozen=True)
class LoadSample:
    event_rate_5m: float = 0
    event_rate_30m: float = 0
    processing_seconds_per_minute: float = 0
    processing_seconds_per_minute_30m: float = 0
    attachment_mib_per_minute: float = 0
    attachment_mib_per_minute_30m: float = 0
    account_errors_10m: float = 0


@dataclass(frozen=True)
class SchedulingConnection:
    id: str
    channel: str
    shard_id: str | None
    enabled: bool
    status: str
    load_units: int
    config: dict[str, Any]


def calculate_load_units(sample: LoadSample) -> int:
    event_rate = max(sample.event_rate_5m, sample.event_rate_30m)
    processing_seconds = max(
        sample.processing_seconds_per_minute,
        sample.processing_seconds_per_minute_30m,
    )
    attachment_mib = max(
        sample.attachment_mib_per_minute,
        sample.attachment_mib_per_minute_30m,
    )
    raw = math.ceil(
        1
        + max(0, event_rate) / 5
        + max(0, processing_seconds) / 15
        + max(0, attachment_mib) / 20
        + 3 * max(0, sample.account_errors_10m)
    )
    return min(12, max(1, raw))


def load_sample_from_config(config: dict[str, Any] | None) -> LoadSample:
    metrics = (config or {}).get('runtime_metrics')
    if not isinstance(metrics, dict):
        return LoadSample()

    def number(key: str) -> float:
        value = metrics.get(key, 0)
        return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0

    return LoadSample(
        event_rate_5m=number('event_rate_5m'),
        event_rate_30m=number('event_rate_30m'),
        processing_seconds_per_minute=number('processing_seconds_per_minute'),
        processing_seconds_per_minute_30m=number('processing_seconds_per_minute_30m'),
        attachment_mib_per_minute=number('attachment_mib_per_minute'),
        attachment_mib_per_minute_30m=number('attachment_mib_per_minute_30m'),
        account_errors_10m=number('account_errors_10m'),
    )


def connection_can_move(connection: SchedulingConnection, *, now: int | None = None) -> bool:
    config = connection.config or {}
    now = int(time.time()) if now is None else now
    last_move_at = config.get('last_shard_move_at', 0)
    in_cooldown = (
        isinstance(last_move_at, (int, float))
        and math.isfinite(last_move_at)
        and last_move_at > now - MOVE_COOLDOWN_SECONDS
    )
    return not (
        connection.status in {'awaiting_scan'}
        or bool(config.get('half_open'))
        or bool(config.get('credential_migration_in_progress'))
        or bool(config.get('control_operation_in_progress'))
        or in_cooldown
    )


def _shard_id(channel: str, index: int) -> str:
    return f'{channel}-shard-{index:03d}'


def _next_shard(channel: str, known: set[str]) -> str:
    index = 0
    while _shard_id(channel, index) in known:
        index += 1
    return _shard_id(channel, index)


def build_rebalance_plan(
    connections: Iterable[SchedulingConnection],
    *,
    account_capacity: int = 12,
    load_capacity: int = 12,
    now: int | None = None,
) -> dict[str, Any]:
    """Return a stable weighted-bin-packing plan without mutating assignments."""
    now = int(time.time()) if now is None else now
    items = [item for item in connections if item.enabled]
    assignments: dict[str, str] = {}
    shard_accounts: dict[str, int] = {}
    shard_load: dict[str, int] = {}
    shard_channel: dict[str, str] = {}
    dedicated_shards: set[str] = set()
    existing_shard_accounts: dict[str, int] = {}
    for item in items:
        if item.shard_id:
            existing_shard_accounts[item.shard_id] = existing_shard_accounts.get(item.shard_id, 0) + 1

    def retain(item: SchedulingConnection) -> None:
        shard_id = item.shard_id
        if not shard_id:
            return
        assignments[item.id] = shard_id
        shard_accounts[shard_id] = shard_accounts.get(shard_id, 0) + 1
        shard_load[shard_id] = shard_load.get(shard_id, 0) + item.load_units
        shard_channel[shard_id] = item.channel
        if item.load_units >= 8 or int((item.config or {}).get('account_error_streak', 0) or 0) >= 3:
            dedicated_shards.add(shard_id)

    # Connections in a transitional state cannot be moved. Keep their real
    # assignment in the plan even when it temporarily exceeds shard capacity.
    for item in sorted(items, key=lambda value: value.id):
        if item.shard_id and not connection_can_move(item, now=now):
            retain(item)

    # Sticky pass: retain healthy assignments up to 120% load capacity.
    for item in sorted(items, key=lambda value: value.id):
        shard_id = item.shard_id
        if not shard_id or item.id in assignments:
            continue
        projected_accounts = shard_accounts.get(shard_id, 0) + 1
        projected_load = shard_load.get(shard_id, 0) + item.load_units
        overloaded_windows = int((item.config or {}).get('overloaded_windows', 0) or 0)
        underloaded_windows = int((item.config or {}).get('underloaded_windows', 0) or 0)
        sticky_limit = math.floor(load_capacity * 1.2)
        requires_isolation = (
            item.load_units >= 8 or int((item.config or {}).get('account_error_streak', 0) or 0) >= 3
        ) and existing_shard_accounts.get(shard_id, 0) > 1
        if (
            not requires_isolation
            and projected_accounts <= account_capacity
            and (projected_load <= sticky_limit or overloaded_windows < 3)
            and underloaded_windows < 30
        ):
            retain(item)

    unassigned = [item for item in items if item.id not in assignments]
    # High-load accounts are isolated first, then remaining accounts use best-fit.
    unassigned.sort(key=lambda value: (-value.load_units, value.id))
    for item in unassigned:
        known = {shard for shard, channel in shard_channel.items() if channel == item.channel}
        candidates = [
            shard
            for shard in known
            if shard not in dedicated_shards
            and shard_accounts.get(shard, 0) < account_capacity
            and shard_load.get(shard, 0) + item.load_units <= load_capacity
        ]
        isolate = item.load_units >= 8 or int((item.config or {}).get('account_error_streak', 0) or 0) >= 3
        if isolate or not candidates:
            shard_id = _next_shard(item.channel, known)
        else:
            shard_id = max(
                candidates,
                key=lambda shard: (shard_load.get(shard, 0), shard_accounts.get(shard, 0), shard),
            )
        assignments[item.id] = shard_id
        shard_accounts[shard_id] = shard_accounts.get(shard_id, 0) + 1
        shard_load[shard_id] = shard_load.get(shard_id, 0) + item.load_units
        shard_channel[shard_id] = item.channel
        if isolate:
            dedicated_shards.add(shard_id)

    moves = []
    by_id = {item.id: item for item in items}
    for connection_id, target in sorted(assignments.items()):
        item = by_id[connection_id]
        if target == item.shard_id or not connection_can_move(item, now=now):
            continue
        moves.append(
            {
                'connection_id': item.id,
                'channel': item.channel,
                'from_shard_id': item.shard_id,
                'to_shard_id': target,
                'load_units': item.load_units,
                'reason': 'new_assignment' if item.shard_id is None else 'capacity_rebalance',
            }
        )

    shards = [
        {
            'id': shard_id,
            'channel': shard_channel[shard_id],
            'accounts': shard_accounts[shard_id],
            'load_units': shard_load[shard_id],
            'account_capacity': account_capacity,
            'load_capacity': load_capacity,
        }
        for shard_id in sorted(shard_channel)
    ]
    return {'moves': moves, 'shards': shards, 'assignments': assignments}
