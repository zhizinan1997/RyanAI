"""Redis-backed lease validation for the bot gateway control plane."""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from typing import Any

from open_webui.env import BOT_GATEWAY_COORDINATION_MODE
from open_webui.utils.redis import get_redis_client

# Lua coordination spans node and shard keys. Keep the versioned keyspace in a
# single Redis Cluster hash slot so the same CAS scripts work in cluster mode.
PREFIX = 'ryanai:bot-gateway:v1:{coord}'


@dataclass(frozen=True)
class CurrentShardLease:
    node_id: str
    lease_id: str
    epoch: int
    assignment_generation: int
    ttl_ms: int


def coordination_mode() -> str:
    return BOT_GATEWAY_COORDINATION_MODE if BOT_GATEWAY_COORDINATION_MODE in {'single', 'redis'} else 'single'


async def current_shard_lease(shard_id: str) -> CurrentShardLease | None:
    if coordination_mode() != 'redis':
        return None
    redis = get_redis_client(async_mode=True)
    if redis is None:
        raise RuntimeError('redis coordination is unavailable')
    key = f'{PREFIX}:shard:{shard_id}:lease'
    value, ttl = await redis.get(key), await redis.pttl(key)
    if not value or ttl <= 0:
        return None
    if isinstance(value, bytes):
        value = value.decode()
    parsed = json.loads(value)
    return CurrentShardLease(
        node_id=str(parsed['nodeId']),
        lease_id=str(parsed['leaseId']),
        epoch=int(parsed['epoch']),
        assignment_generation=int(parsed['assignmentGeneration']),
        ttl_ms=int(ttl),
    )


def _node_score(snapshot: dict[str, Any]) -> tuple[float, str]:
    queue = snapshot.get('queue') if isinstance(snapshot.get('queue'), dict) else {}
    operations = snapshot.get('operations') if isinstance(snapshot.get('operations'), dict) else {}
    shards = operations.get('shards') if isinstance(operations.get('shards'), list) else []
    cpu = snapshot.get('cpuPercent', 0)
    rss = snapshot.get('rssBytes', 0)
    active = queue.get('active', 0)
    queued = queue.get('queued', 0)
    score = (
        max(0.0, float(cpu))
        + max(0.0, float(rss)) / (256 * 1024 * 1024)
        + max(0.0, float(active)) * 2
        + max(0.0, float(queued)) * 4
        + len(shards) * 5
    )
    return score, str(snapshot.get('nodeId') or '')


async def ensure_shard_targets(shard_ids: list[str]) -> dict[str, str]:
    """Refresh sticky shard targets while holding the scheduler leader lease."""
    if coordination_mode() != 'redis' or not shard_ids:
        return {}
    redis = get_redis_client(async_mode=True)
    if redis is None:
        raise RuntimeError('redis coordination is unavailable')
    leader_id = secrets.token_hex(16)
    leader_key = f'{PREFIX}:scheduler:leader'
    if not await redis.set(leader_key, leader_id, nx=True, px=15_000):
        return {}
    try:
        nodes: dict[str, dict[str, Any]] = {}
        async for key in redis.scan_iter(match=f'{PREFIX}:node:*:heartbeat'):
            raw = await redis.get(key)
            if not raw:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode()
            try:
                snapshot = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            node_id = str(snapshot.get('nodeId') or '')
            if not node_id or await redis.exists(f'{PREFIX}:node:{node_id}:draining'):
                continue
            nodes[node_id] = snapshot
        if not nodes:
            return {}
        targets: dict[str, str] = {}
        for shard_id in sorted(set(shard_ids)):
            target_key = f'{PREFIX}:shard:{shard_id}:target'
            current = await redis.get(target_key)
            if isinstance(current, bytes):
                current = current.decode()
            if current in nodes:
                targets[shard_id] = str(current)
                continue
            target = min(nodes.values(), key=_node_score)
            node_id = str(target['nodeId'])
            await redis.set(target_key, node_id)
            targets[shard_id] = node_id
            operations = target.get('operations') if isinstance(target.get('operations'), dict) else {}
            shards = operations.setdefault('shards', []) if isinstance(operations, dict) else []
            if isinstance(shards, list):
                shards.append({'shard_id': shard_id})
        return targets
    finally:
        await redis.eval(
            "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
            1,
            leader_key,
            leader_id,
        )


async def validate_event_fence(
    *,
    shard_id: str | None,
    node_id: str | None,
    lease_epoch: int | None,
    assignment_generation: int | None,
    expected_shard_id: str | None,
    expected_assignment_generation: int,
) -> bool:
    if coordination_mode() != 'redis':
        return True
    if (
        not shard_id
        or not node_id
        or lease_epoch is None
        or assignment_generation is None
        or shard_id != expected_shard_id
        or assignment_generation != expected_assignment_generation
    ):
        return False
    lease = await current_shard_lease(shard_id)
    return bool(
        lease
        and lease.node_id == node_id
        and lease.epoch == lease_epoch
        and lease.assignment_generation == assignment_generation
    )
