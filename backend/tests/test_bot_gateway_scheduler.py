import fnmatch
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from open_webui.models.bot_gateway import BotGatewayConnectionModel
from open_webui.routers import bot_gateway as gateway_router
from open_webui.utils import bot_gateway_coordination as coordination
from open_webui.utils.bot_gateway_scheduler import (
    LoadSample,
    SchedulingConnection,
    build_rebalance_plan,
    calculate_load_units,
    connection_can_move,
    load_sample_from_config,
)


def connection(
    connection_id: str,
    *,
    shard_id: str | None = None,
    load_units: int = 1,
    status: str = 'connected',
    config: dict | None = None,
) -> SchedulingConnection:
    return SchedulingConnection(
        id=connection_id,
        channel='qq',
        shard_id=shard_id,
        enabled=True,
        status=status,
        load_units=load_units,
        config=config or {},
    )


class BotGatewayLoadSchedulerTests(TestCase):
    def test_load_units_follow_formula_and_clamp(self):
        self.assertEqual(calculate_load_units(LoadSample()), 1)
        self.assertEqual(
            calculate_load_units(
                LoadSample(
                    event_rate_5m=10,
                    processing_seconds_per_minute=15,
                    attachment_mib_per_minute=20,
                    account_errors_10m=1,
                )
            ),
            8,
        )
        self.assertEqual(calculate_load_units(LoadSample(event_rate_5m=10_000)), 12)
        self.assertEqual(calculate_load_units(LoadSample(event_rate_5m=-10)), 1)

    def test_load_units_use_the_higher_five_or_thirty_minute_signal(self):
        self.assertEqual(calculate_load_units(LoadSample(event_rate_30m=10)), 3)
        self.assertEqual(
            calculate_load_units(
                LoadSample(
                    processing_seconds_per_minute_30m=15,
                    attachment_mib_per_minute_30m=20,
                )
            ),
            3,
        )

    def test_runtime_metrics_ignore_invalid_values(self):
        sample = load_sample_from_config(
            {
                'runtime_metrics': {
                    'event_rate_5m': 5,
                    'processing_seconds_per_minute': float('nan'),
                    'attachment_mib_per_minute': '20',
                    'account_errors_10m': 1,
                }
            }
        )
        self.assertEqual(sample, LoadSample(event_rate_5m=5, account_errors_10m=1))

    def test_healthy_assignments_are_sticky(self):
        plan = build_rebalance_plan(
            [
                connection('a', shard_id='qq-shard-000', load_units=3),
                connection('b', shard_id='qq-shard-000', load_units=3),
                connection('c', load_units=4),
            ]
        )
        self.assertEqual(
            plan['moves'],
            [
                {
                    'connection_id': 'c',
                    'channel': 'qq',
                    'from_shard_id': None,
                    'to_shard_id': 'qq-shard-000',
                    'load_units': 4,
                    'reason': 'new_assignment',
                }
            ],
        )
        self.assertEqual(plan['assignments']['a'], 'qq-shard-000')
        self.assertEqual(plan['assignments']['b'], 'qq-shard-000')

    def test_high_load_account_is_split_from_shared_shard(self):
        plan = build_rebalance_plan(
            [
                connection('busy', shard_id='qq-shard-000', load_units=8),
                connection('quiet', shard_id='qq-shard-000', load_units=1),
            ]
        )
        self.assertEqual(plan['assignments']['busy'], 'qq-shard-001')
        self.assertEqual(plan['assignments']['quiet'], 'qq-shard-000')
        self.assertEqual([move['connection_id'] for move in plan['moves']], ['busy'])

    def test_already_isolated_high_load_account_stays_put(self):
        plan = build_rebalance_plan(
            [
                connection('busy', shard_id='qq-shard-001', load_units=12),
                connection('quiet', shard_id='qq-shard-000', load_units=1),
            ]
        )
        self.assertEqual(plan['assignments']['busy'], 'qq-shard-001')
        self.assertEqual(plan['moves'], [])

    def test_new_connections_do_not_join_a_dedicated_high_load_shard(self):
        plan = build_rebalance_plan(
            [
                connection('busy', load_units=8),
                connection('quiet', load_units=1),
            ]
        )
        self.assertNotEqual(plan['assignments']['busy'], plan['assignments']['quiet'])

    def test_immovable_connection_remains_in_plan_when_overloaded(self):
        items = [
            connection(
                'scanning',
                shard_id='qq-shard-000',
                load_units=12,
                status='awaiting_scan',
                config={'overloaded_windows': 3},
            ),
            connection('other', shard_id='qq-shard-000', load_units=4, config={'overloaded_windows': 3}),
        ]
        plan = build_rebalance_plan(items)
        self.assertFalse(connection_can_move(items[0]))
        self.assertEqual(plan['assignments']['scanning'], 'qq-shard-000')
        self.assertNotIn('scanning', [move['connection_id'] for move in plan['moves']])
        shard = next(item for item in plan['shards'] if item['id'] == 'qq-shard-000')
        self.assertGreaterEqual(shard['load_units'], 12)

    def test_all_transitional_flags_prevent_moves(self):
        for config in (
            {'half_open': True},
            {'credential_migration_in_progress': True},
            {'control_operation_in_progress': True},
        ):
            with self.subTest(config=config):
                self.assertFalse(connection_can_move(connection('a', config=config)))

    def test_recent_move_cooldown_prevents_another_move(self):
        item = connection('a', config={'last_shard_move_at': 9_500})
        self.assertFalse(connection_can_move(item, now=10_000))
        self.assertTrue(connection_can_move(item, now=12_000))

    def test_sustained_underload_allows_shards_to_merge(self):
        plan = build_rebalance_plan(
            [
                connection('a', shard_id='qq-shard-000', config={'underloaded_windows': 30}),
                connection('b', shard_id='qq-shard-001', config={'underloaded_windows': 30}),
            ],
            now=10_000,
        )
        self.assertEqual(len(set(plan['assignments'].values())), 1)
        self.assertEqual(len(plan['moves']), 1)


def connection_model(
    connection_id: str,
    *,
    shard_id: str | None = None,
    config: dict | None = None,
) -> BotGatewayConnectionModel:
    return BotGatewayConnectionModel(
        id=connection_id,
        channel='qq',
        name=connection_id,
        enabled=True,
        status='connected',
        credentials_configured=True,
        shard_id=shard_id,
        config=config or {},
        created_at=1,
        updated_at=1,
    )


class BotGatewayRebalanceApplyTests(IsolatedAsyncioTestCase):
    async def test_shadow_and_static_modes_reject_apply(self):
        for mode in ('shadow', 'static'):
            with self.subTest(mode=mode), patch.object(gateway_router, 'BOT_GATEWAY_SCHEDULER_MODE', mode):
                with self.assertRaises(gateway_router.HTTPException) as raised:
                    await gateway_router.apply_rebalance(
                        gateway_router.RebalanceApplyForm(),
                        user=SimpleNamespace(id='admin'),
                        db=None,
                    )
            self.assertEqual(raised.exception.status_code, 409)
            self.assertIn(mode, raised.exception.detail)

    async def test_auto_mode_applies_one_current_plan_move(self):
        item = connection_model('new-account')
        moved = item.model_copy(update={'shard_id': 'qq-shard-000', 'assignment_generation': 1})
        operation = SimpleNamespace(id='operation-1')
        with (
            patch.object(gateway_router, 'BOT_GATEWAY_SCHEDULER_MODE', 'auto'),
            patch.object(gateway_router.BotGateway, 'list_connections', AsyncMock(return_value=[item])),
            patch.object(gateway_router.BotGateway, 'list_control_operations', AsyncMock(return_value=[])),
            patch.object(gateway_router.BotGateway, 'apply_shard_assignments', AsyncMock(return_value=[moved])) as apply,
            patch.object(
                gateway_router.BotGateway,
                'record_control_operation',
                AsyncMock(return_value=operation),
            ) as record,
        ):
            response = await gateway_router.apply_rebalance(
                gateway_router.RebalanceApplyForm(),
                user=SimpleNamespace(id='admin'),
                db=None,
            )
        apply.assert_awaited_once_with({'new-account': 'qq-shard-000'}, db=None)
        self.assertEqual(record.await_args.kwargs['payload']['moves'][0]['connection_id'], 'new-account')
        self.assertEqual(response['operation_id'], 'operation-1')
        self.assertEqual(response['updated'][0]['shard_id'], 'qq-shard-000')

    async def test_auto_mode_rejects_more_than_one_move(self):
        with (
            patch.object(gateway_router, 'BOT_GATEWAY_SCHEDULER_MODE', 'auto'),
            patch.object(
                gateway_router.BotGateway,
                'list_connections',
                AsyncMock(return_value=[connection_model('a'), connection_model('b')]),
            ),
        ):
            with self.assertRaises(gateway_router.HTTPException) as raised:
                await gateway_router.apply_rebalance(
                    gateway_router.RebalanceApplyForm(
                        moves=[
                            {'connection_id': 'a', 'to_shard_id': 'qq-shard-000'},
                            {'connection_id': 'b', 'to_shard_id': 'qq-shard-000'},
                        ]
                    ),
                    user=SimpleNamespace(id='admin'),
                    db=None,
                )
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn('at most one', raised.exception.detail)

    async def test_auto_mode_enforces_two_minute_move_interval(self):
        now = 10_000
        recent = SimpleNamespace(created_at=now - 30, payload={'moves': [{}]})
        with (
            patch.object(gateway_router, 'BOT_GATEWAY_SCHEDULER_MODE', 'auto'),
            patch.object(gateway_router.time, 'time', return_value=now),
            patch.object(
                gateway_router.BotGateway,
                'list_connections',
                AsyncMock(return_value=[connection_model('new-account')]),
            ),
            patch.object(gateway_router.BotGateway, 'list_control_operations', AsyncMock(return_value=[recent])),
        ):
            with self.assertRaises(gateway_router.HTTPException) as raised:
                await gateway_router.apply_rebalance(
                    gateway_router.RebalanceApplyForm(),
                    user=SimpleNamespace(id='admin'),
                    db=None,
                )
        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn('interval', raised.exception.detail)

    async def test_auto_mode_enforces_hourly_move_budget(self):
        now = 10_000
        recent = SimpleNamespace(created_at=now - 300, payload={'moves': [{}]})
        connections = [
            connection_model('existing', shard_id='qq-shard-000'),
            connection_model('new-account'),
        ]
        with (
            patch.object(gateway_router, 'BOT_GATEWAY_SCHEDULER_MODE', 'auto'),
            patch.object(gateway_router.time, 'time', return_value=now),
            patch.object(gateway_router.BotGateway, 'list_connections', AsyncMock(return_value=connections)),
            patch.object(gateway_router.BotGateway, 'list_control_operations', AsyncMock(return_value=[recent])),
        ):
            with self.assertRaises(gateway_router.HTTPException) as raised:
                await gateway_router.apply_rebalance(
                    gateway_router.RebalanceApplyForm(),
                    user=SimpleNamespace(id='admin'),
                    db=None,
                )
        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn('hourly', raised.exception.detail)


class FakeRedis:
    def __init__(self, *, leader=True):
        self.values = {}
        self.leader = leader
        self.eval_calls = []

    async def set(self, key, value, **kwargs):
        if kwargs.get('nx') and not self.leader:
            return False
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)

    async def exists(self, key):
        return int(key in self.values)

    async def scan_iter(self, *, match):
        for key in sorted(self.values):
            if fnmatch.fnmatchcase(key, match):
                yield key

    async def eval(self, script, numkeys, *keys_and_args):
        self.eval_calls.append((script, numkeys, keys_and_args))
        key, expected = keys_and_args
        if self.values.get(key) == expected:
            del self.values[key]
            return 1
        return 0


class BotGatewayNodeTargetTests(IsolatedAsyncioTestCase):
    async def test_node_score_prefers_lower_runtime_load(self):
        quiet = {'nodeId': 'quiet', 'cpuPercent': 2, 'rssBytes': 64 * 1024 * 1024}
        busy = {
            'nodeId': 'busy',
            'cpuPercent': 20,
            'rssBytes': 512 * 1024 * 1024,
            'queue': {'active': 4, 'queued': 10},
            'operations': {'shards': [{'shard_id': 'qq-shard-000'}]},
        }
        self.assertLess(coordination._node_score(quiet), coordination._node_score(busy))

    async def test_targets_are_sticky_and_draining_nodes_are_skipped(self):
        redis = FakeRedis()
        prefix = coordination.PREFIX
        redis.values[f'{prefix}:node:node-a:heartbeat'] = '{"nodeId":"node-a","cpuPercent":1,"rssBytes":1}'
        redis.values[f'{prefix}:node:node-b:heartbeat'] = '{"nodeId":"node-b","cpuPercent":20,"rssBytes":1}'
        redis.values[f'{prefix}:shard:qq-shard-000:target'] = 'node-b'
        redis.values[f'{prefix}:node:node-b:draining'] = '1'
        with (
            patch.object(coordination, 'BOT_GATEWAY_COORDINATION_MODE', 'redis'),
            patch.object(coordination, 'get_redis_client', return_value=redis),
        ):
            targets = await coordination.ensure_shard_targets(['qq-shard-000', 'qq-shard-001'])
        self.assertEqual(targets, {'qq-shard-000': 'node-a', 'qq-shard-001': 'node-a'})
        self.assertEqual(redis.values[f'{prefix}:shard:qq-shard-000:target'], 'node-a')
        self.assertEqual(redis.eval_calls[0][1], 1)

    async def test_non_leader_does_not_rewrite_targets(self):
        redis = FakeRedis(leader=False)
        with (
            patch.object(coordination, 'BOT_GATEWAY_COORDINATION_MODE', 'redis'),
            patch.object(coordination, 'get_redis_client', return_value=redis),
        ):
            self.assertEqual(await coordination.ensure_shard_targets(['qq-shard-000']), {})
        self.assertEqual(redis.eval_calls, [])
