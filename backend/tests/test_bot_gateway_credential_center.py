import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

# 凭证中心主密钥必须在本模块导入任何 open_webui 模块前设置，因为 env.py 在
# 导入时读取环境变量；运行时可通过 os.getenv 覆盖（见 bot_gateway_crypto）。
os.environ.setdefault('BOT_GATEWAY_CREDENTIAL_MASTER_KEY', 'f' * 64)

from open_webui.internal.db import Base
from open_webui.models import bot_gateway as gateway_models
from open_webui.models.bot_gateway import (
    BotGatewayBindingError,
    BotGatewayConnection,
    BotGatewayAccountCheckpoint,
    BotGatewayControlOperation,
    BotGatewayCredential,
    BotGatewayNode,
    BotGatewayShard,
    BotGatewayTable,
)
from open_webui.models.users import User
from open_webui.utils.bot_gateway_crypto import (
    BotGatewayCredentialError,
    bot_gateway_credential_master_key,
    credential_account_digest,
    decrypt_bot_checkpoint,
    decrypt_bot_credentials,
    encrypt_bot_credentials,
    encrypt_bot_checkpoint,
    extract_account_key,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _temp_db_engine():
    temp_dir = tempfile.TemporaryDirectory()
    database_path = Path(temp_dir.name, 'bot-gateway-credential.db').as_posix()
    engine = create_async_engine(f'sqlite+aiosqlite:///{database_path}')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tables = [
        User.__table__,
        BotGatewayConnection.__table__,
        BotGatewayCredential.__table__,
        BotGatewayShard.__table__,
        BotGatewayNode.__table__,
        BotGatewayControlOperation.__table__,
        BotGatewayAccountCheckpoint.__table__,
    ]
    return temp_dir, engine, sessions, tables


class BotGatewayCredentialCryptoTests(TestCase):
    def test_master_key_parses_to_32_bytes(self):
        self.assertEqual(len(bot_gateway_credential_master_key()), 32)

    def test_master_key_rejects_invalid_values(self):
        for bad in ('', 'short', 'g' * 64, 'a' * 63):
            with self.subTest(value=bad), patch.dict(os.environ, {'BOT_GATEWAY_CREDENTIAL_MASTER_KEY': bad}):
                with self.assertRaises(BotGatewayCredentialError):
                    bot_gateway_credential_master_key()

    def test_master_key_accepts_base64_encoded_value(self):
        import base64

        value = base64.b64encode(b'k' * 32).decode()
        with patch.dict(os.environ, {'BOT_GATEWAY_CREDENTIAL_MASTER_KEY': value}):
            self.assertEqual(bot_gateway_credential_master_key(), b'k' * 32)

    def test_account_digest_is_stable_and_channel_scoped(self):
        self.assertEqual(
            credential_account_digest('qq', '10001'),
            credential_account_digest('qq', '10001'),
        )
        self.assertNotEqual(
            credential_account_digest('qq', '10001'),
            credential_account_digest('qq', '10002'),
        )
        self.assertNotEqual(
            credential_account_digest('qq', '10001'),
            credential_account_digest('wechat', '10001'),
        )

    def test_encrypt_decrypt_round_trip_preserves_credentials(self):
        credentials = {'app_id': '10001', 'app_secret': 'secret-1'}
        envelope = encrypt_bot_credentials(credentials, 'qq-default', 'qq')
        self.assertEqual(envelope['version'], 1)
        self.assertEqual(envelope['key_version'], 1)
        self.assertEqual(envelope['schema_version'], 1)
        self.assertEqual(decrypt_bot_credentials(envelope, 'qq-default', 'qq'), credentials)

    def test_decrypt_fails_when_connection_id_in_aad_changes(self):
        envelope = encrypt_bot_credentials({'app_id': '10001'}, 'qq-default', 'qq')
        with self.assertRaises(BotGatewayCredentialError):
            decrypt_bot_credentials(envelope, 'other-connection', 'qq')

    def test_decrypt_fails_when_channel_in_aad_changes(self):
        envelope = encrypt_bot_credentials({'app_id': '10001'}, 'qq-default', 'qq')
        with self.assertRaises(BotGatewayCredentialError):
            decrypt_bot_credentials(envelope, 'qq-default', 'wechat')

    def test_extract_account_key_uses_app_id_or_account_id(self):
        self.assertEqual(extract_account_key('qq', {'app_id': '10001'}), '10001')
        self.assertEqual(extract_account_key('wechat', {'accountId': 'wx-id'}), 'wx-id')
        with self.assertRaises(BotGatewayCredentialError):
            extract_account_key('qq', {})
        with self.assertRaises(BotGatewayCredentialError):
            extract_account_key('wechat', {'app_id': '10001'})

    def test_checkpoint_encryption_is_connection_bound(self):
        envelope = encrypt_bot_checkpoint(b'{"cursor":42}', 'wechat-default')
        self.assertEqual(decrypt_bot_checkpoint(envelope, 'wechat-default'), b'{"cursor":42}')
        with self.assertRaises(BotGatewayCredentialError):
            decrypt_bot_checkpoint(envelope, 'other-connection')


class BotGatewayCredentialTableTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir, self.engine, self.sessions, tables = _temp_db_engine()
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync_connection: Base.metadata.create_all(sync_connection, tables=tables))

        @asynccontextmanager
        async def test_db_context(db=None):
            if isinstance(db, AsyncSession):
                yield db
            else:
                async with self.sessions() as session:
                    yield session

        self.context_patcher = patch.object(gateway_models, 'get_async_db_context', test_db_context)
        self.context_patcher.start()
        self.gateway = BotGatewayTable()
        self.credentials_table = gateway_models.BotGatewayCredentials
        self.checkpoints_table = gateway_models.BotGatewayCheckpoints
        await self._seed_connections()

    async def asyncTearDown(self):
        self.context_patcher.stop()
        await self.engine.dispose()
        self.temp_dir.cleanup()

    async def _seed_connections(self):
        now = int(time.time())
        async with self.sessions() as session:
            session.add_all(
                [
                    User(
                        id='user-1',
                        email='user@example.com',
                        role='user',
                        name='Test User',
                        last_active_at=now,
                        updated_at=now,
                        created_at=now,
                    ),
                    BotGatewayConnection(
                        id='qq-default',
                        channel='qq',
                        name='QQ',
                        enabled=True,
                        status='connected',
                        credentials_configured=True,
                        config={},
                        created_at=now,
                        updated_at=now,
                    ),
                    BotGatewayConnection(
                        id='qq-second',
                        channel='qq',
                        name='QQ2',
                        enabled=True,
                        status='connected',
                        credentials_configured=True,
                        config={},
                        created_at=now,
                        updated_at=now,
                    ),
                    BotGatewayConnection(
                        id='wechat-default',
                        channel='wechat',
                        name='WeChat',
                        enabled=True,
                        status='connected',
                        credentials_configured=True,
                        config={},
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )
            await session.commit()

    async def test_account_digest_unique_across_connections(self):
        qq_credentials = {'app_id': '10001', 'app_secret': 'secret-1'}
        await self.credentials_table.save_credential(None, 'qq-default', 'qq', qq_credentials)
        with self.assertRaises(BotGatewayBindingError) as raised:
            await self.credentials_table.save_credential(None, 'qq-second', 'qq', qq_credentials)
        self.assertEqual(raised.exception.code, 'account_already_bound')

        # 同 connection 覆盖保存必须成功。
        updated = await self.credentials_table.save_credential(
            None, 'qq-default', 'qq', {'app_id': '10001', 'app_secret': 'secret-2'}
        )
        self.assertEqual(updated['account_digest'], credential_account_digest('qq', '10001'))
        stored = await self.credentials_table.get_credential(None, 'qq-default')
        self.assertEqual(stored, {'app_id': '10001', 'app_secret': 'secret-2'})

    async def test_save_get_delete_credential_round_trip(self):
        self.assertIsNone(await self.credentials_table.get_credential(None, 'wechat-default'))
        self.assertFalse(await self.credentials_table.connection_has_credential(None, 'wechat-default'))

        await self.credentials_table.save_credential(
            None, 'wechat-default', 'wechat', {'accountId': 'wx-id', 'sessionToken': 'token-1'}
        )
        stored = await self.credentials_table.get_credential(None, 'wechat-default')
        self.assertEqual(stored, {'accountId': 'wx-id', 'sessionToken': 'token-1'})
        self.assertTrue(await self.credentials_table.connection_has_credential(None, 'wechat-default'))

        await self.credentials_table.delete_credential(None, 'wechat-default')
        self.assertIsNone(await self.credentials_table.get_credential(None, 'wechat-default'))
        self.assertFalse(await self.credentials_table.connection_has_credential(None, 'wechat-default'))

    async def test_list_credential_digests_exposes_no_plaintext(self):
        await self.credentials_table.save_credential(
            None, 'qq-default', 'qq', {'app_id': '10001', 'app_secret': 'secret-1'}
        )
        await self.credentials_table.save_credential(
            None, 'wechat-default', 'wechat', {'accountId': 'wx-id', 'sessionToken': 'token-1'}
        )
        digests = await self.credentials_table.list_credential_digests()
        by_connection = {item['connection_id']: item for item in digests}
        self.assertEqual(by_connection['qq-default']['channel'], 'qq')
        self.assertEqual(
            by_connection['qq-default']['account_digest'],
            credential_account_digest('qq', '10001'),
        )
        self.assertNotIn('secret-1', json.dumps(digests))
        self.assertNotIn('token-1', json.dumps(digests))

    async def test_checkpoint_table_encrypts_and_round_trips_payload(self):
        payload = b'{"version":1,"files":[]}'
        sha256 = __import__('hashlib').sha256(payload).hexdigest()
        await self.checkpoints_table.save(None, 'wechat-default', payload, sha256)
        self.assertEqual(await self.checkpoints_table.get(None, 'wechat-default'), (payload, sha256))
        async with self.sessions() as session:
            stored = await session.get(BotGatewayAccountCheckpoint, 'wechat-default')
        self.assertNotIn(payload.decode(), stored.payload)

    async def test_set_connection_runtime_updates_only_provided_fields(self):
        now = int(time.time())
        await self.gateway.set_connection_runtime(
            None,
            'qq-default',
            shard_id='shard-1',
            assignment_generation=3,
            last_runtime_node_id='node-1',
            last_runtime_at=now,
        )
        connection = await self.gateway.get_connection('qq-default')
        self.assertEqual(connection.shard_id, 'shard-1')
        self.assertEqual(connection.assignment_generation, 3)
        self.assertEqual(connection.last_runtime_node_id, 'node-1')
        self.assertEqual(connection.last_runtime_at, now)
        self.assertIsNone(connection.account_key)

        await self.gateway.set_connection_runtime(None, 'missing-connection', shard_id='shard-2')
        self.assertIsNone(await self.gateway.get_connection('missing-connection'))

    async def test_connection_model_normalizes_legacy_null_assignment_generation(self):
        async with self.sessions() as session:
            stored = await session.get(BotGatewayConnection, 'qq-default')
            stored.assignment_generation = None
            await session.commit()

        connection = await self.gateway.get_connection('qq-default')
        self.assertEqual(connection.assignment_generation, 0)

    async def test_node_upsert_and_touch(self):
        now = int(time.time())
        node = await self.gateway.upsert_node(
            'node-1',
            advertise_url='http://node-1:8787',
            capabilities={'channels': ['qq', 'wechat']},
        )
        self.assertEqual(node.id, 'node-1')
        self.assertEqual(node.last_seen_at, node.updated_at)
        self.assertTrue(await self.gateway.touch_node('node-1'))
        self.assertFalse(await self.gateway.touch_node('ghost-node'))
        self.assertEqual(len(await self.gateway.list_nodes()), 1)

    async def test_record_control_operation_writes_audit_row(self):
        operation = await self.gateway.record_control_operation(
            kind='circuit_reset',
            payload={'connection_id': 'qq-default'},
            actor_user_id='user-1',
        )
        self.assertEqual(operation.status, 'completed')
        self.assertIsNotNone(operation.completed_at)
        async with self.sessions() as session:
            rows = (await session.execute(select(BotGatewayControlOperation))).scalars().all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].kind, 'circuit_reset')

    async def test_assignment_move_records_cooldown_timestamp(self):
        updated = await self.gateway.apply_shard_assignments({'qq-default': 'qq-shard-001'})
        self.assertEqual(updated[0].shard_id, 'qq-shard-001')
        self.assertGreater(updated[0].config['last_shard_move_at'], 0)

    async def test_control_operations_can_be_filtered_by_kind_and_time(self):
        await self.gateway.record_control_operation(kind='circuit_reset')
        expected = await self.gateway.record_control_operation(kind='rebalance_apply', payload={'moves': [{}]})
        rows = await self.gateway.list_control_operations(kind='rebalance_apply', since=expected.created_at - 1)
        self.assertEqual([row.id for row in rows], [expected.id])

    async def test_runtime_metrics_update_load_windows_once_per_minute(self):
        await self.gateway.set_connection_runtime(
            None,
            'qq-default',
            shard_id='qq-shard-000',
            assignment_generation=2,
        )
        metrics = {
            'qq-default': {
                'event_rate_5m': 60,
                'processing_seconds_per_minute': 60,
                'attachment_mib_per_minute': 20,
                'account_errors_10m': 0,
                'account_error_streak': 0,
            }
        }
        with patch.object(gateway_models.time, 'time', return_value=60_000):
            self.assertEqual(
                await self.gateway.update_connection_runtime_metrics('node-a', metrics, load_capacity=8),
                1,
            )
            await self.gateway.update_connection_runtime_metrics('node-a', metrics, load_capacity=8)
        connection = await self.gateway.get_connection('qq-default')
        self.assertEqual(connection.last_runtime_node_id, 'node-a')
        self.assertEqual(connection.config['overloaded_windows'], 1)
        self.assertEqual(connection.config['runtime_metrics']['event_rate_5m'], 60)


class BotGatewayCredentialRouterTests(IsolatedAsyncioTestCase):
    def setUp(self):
        from open_webui.routers import bot_gateway as gateway_router

        self.gateway_router = gateway_router
        self.gateway_router._conversation_locks.clear()

    async def asyncSetUp(self):
        self.temp_dir, self.engine, self.sessions, tables = _temp_db_engine()
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync_connection: Base.metadata.create_all(sync_connection, tables=tables))

        @asynccontextmanager
        async def test_db_context(db=None):
            if isinstance(db, AsyncSession):
                yield db
            else:
                async with self.sessions() as session:
                    yield session

        self.context_patcher = patch.object(gateway_models, 'get_async_db_context', test_db_context)
        self.context_patcher.start()
        self.gateway = BotGatewayTable()
        self.credentials_table = gateway_models.BotGatewayCredentials
        now = int(time.time())
        async with self.sessions() as session:
            session.add_all(
                [
                    User(
                        id='user-1',
                        email='user@example.com',
                        role='user',
                        name='Test User',
                        last_active_at=now,
                        updated_at=now,
                        created_at=now,
                    ),
                    BotGatewayConnection(
                        id='qq-default',
                        channel='qq',
                        name='QQ',
                        enabled=True,
                        status='connected',
                        credentials_configured=True,
                        config={},
                        created_at=now,
                        updated_at=now,
                    ),
                    BotGatewayConnection(
                        id='qq-second',
                        channel='qq',
                        name='QQ2',
                        enabled=True,
                        status='connected',
                        credentials_configured=True,
                        config={},
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )
            await session.commit()

    async def asyncTearDown(self):
        self.context_patcher.stop()
        await self.engine.dispose()
        self.temp_dir.cleanup()

    def _request(self, body: bytes) -> SimpleNamespace:
        return SimpleNamespace(body=AsyncMock(return_value=body))

    def _verified(self) -> AsyncMock:
        return patch.object(
            self.gateway_router,
            '_verify_internal_request',
            AsyncMock(return_value=('nonce', 'hash', b'')),
        )

    async def test_internal_credential_store_read_and_delete_end_to_end(self):
        body = json.dumps(
            {
                'connection_id': 'qq-default',
                'channel': 'qq',
                'credentials': {'app_id': '10001', 'app_secret': 'secret-1'},
            }
        ).encode()
        with self._verified():
            response = await self.gateway_router.store_internal_credential(self._request(body), db=None)
        self.assertEqual(response['version'], '1.0')
        self.assertTrue(response['stored'])
        self.assertEqual(response['account_digest'], credential_account_digest('qq', '10001'))

        with self._verified():
            response = await self.gateway_router.get_internal_credential('qq-default', self._request(b''), db=None)
        self.assertEqual(response['credentials'], {'app_id': '10001', 'app_secret': 'secret-1'})

        with self._verified():
            response = await self.gateway_router.delete_internal_credential('qq-default', self._request(b''), db=None)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(await self.credentials_table.connection_has_credential(None, 'qq-default'))

    async def test_duplicate_account_returns_409_account_already_bound(self):
        body = json.dumps(
            {'connection_id': 'qq-default', 'channel': 'qq', 'credentials': {'app_id': '10001', 'app_secret': 's1'}}
        ).encode()
        with self._verified():
            await self.gateway_router.store_internal_credential(self._request(body), db=None)
            response = await self.gateway_router.store_internal_credential(
                self._request(
                    json.dumps(
                        {
                            'connection_id': 'qq-second',
                            'channel': 'qq',
                            'credentials': {'app_id': '10001', 'app_secret': 's2'},
                        }
                    ).encode()
                ),
                db=None,
            )
        self.assertEqual(response.status_code, 409)
        payload = json.loads(response.body)
        self.assertEqual(payload['version'], '1.0')
        self.assertEqual(payload['error']['code'], 'account_already_bound')

    async def test_overwrite_endpoint_stores_credentials(self):
        body = json.dumps({'channel': 'qq', 'credentials': {'app_id': '10001', 'app_secret': 's1'}}).encode()
        with self._verified():
            response = await self.gateway_router.overwrite_internal_credential(
                'qq-default', self._request(body), db=None
            )
        self.assertTrue(response['stored'])
        self.assertEqual(
            await self.credentials_table.get_credential(None, 'qq-default'),
            {'app_id': '10001', 'app_secret': 's1'},
        )

    async def test_store_credential_requires_existing_connection(self):
        body = json.dumps(
            {
                'connection_id': 'missing-connection',
                'channel': 'qq',
                'credentials': {'app_id': '10001', 'app_secret': 's1'},
            }
        ).encode()
        with self._verified():
            response = await self.gateway_router.store_internal_credential(self._request(body), db=None)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(json.loads(response.body)['error']['code'], 'connection_not_found')

    async def test_credential_center_disabled_returns_503(self):
        body = json.dumps(
            {'connection_id': 'qq-default', 'channel': 'qq', 'credentials': {'app_id': '10001', 'app_secret': 's1'}}
        ).encode()
        with (
            self._verified(),
            patch.dict(os.environ, {'BOT_GATEWAY_CREDENTIAL_MASTER_KEY': ''}),
        ):
            response = await self.gateway_router.store_internal_credential(self._request(body), db=None)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body)['error']['code'], 'credential_center_disabled')

    async def test_desired_state_marks_credentials_without_n_plus_one(self):
        body = json.dumps(
            {'connection_id': 'qq-default', 'channel': 'qq', 'credentials': {'app_id': '10001', 'app_secret': 's1'}}
        ).encode()
        with self._verified():
            await self.gateway_router.store_internal_credential(self._request(body), db=None)
            response = await self.gateway_router.get_desired_state(self._request(b''), db=None)
        connections = {item['id']: item for item in response['connections']}
        self.assertTrue(connections['qq-default']['credentials_configured'])
        self.assertFalse(connections['qq-second']['credentials_configured'])
        self.assertEqual(connections['qq-default']['channel'], 'qq')
        self.assertIn('shard_id', connections['qq-default'])
        self.assertIn('assignment_generation', connections['qq-default'])

    async def test_node_register_heartbeat_and_unknown_heartbeat(self):
        body = json.dumps(
            {'node_id': 'node-1', 'advertise_url': 'http://node-1:8787', 'capabilities': {'channels': ['qq']}}
        ).encode()
        with self._verified():
            response = await self.gateway_router.register_gateway_node(self._request(body), db=None)
        self.assertEqual(response['node']['id'], 'node-1')

        with self._verified():
            response = await self.gateway_router.gateway_node_heartbeat(
                'node-1', self._request(json.dumps({'metrics': {'load': 0.5}}).encode()), db=None
            )
        self.assertEqual(response['node_id'], 'node-1')

        # Node capabilities remain stable; runtime metrics are stored on the
        # matching connection records instead of bloating the node row.
        async with self.sessions() as session:
            node = await session.get(BotGatewayNode, 'node-1')
        self.assertEqual(node.capabilities, {'channels': ['qq']})

        with self._verified():
            response = await self.gateway_router.gateway_node_heartbeat('ghost-node', self._request(b'{}'), db=None)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(json.loads(response.body)['error']['code'], 'node_not_found')

    async def test_node_heartbeat_persists_sanitized_connection_load_metrics(self):
        register = json.dumps({'node_id': 'node-load', 'advertise_url': 'http://node-load:8787'}).encode()
        heartbeat = json.dumps(
            {
                'metrics': {
                    'connections': {
                        'qq-default': {
                            'event_rate_5m': 10,
                            'processing_seconds_per_minute': 3,
                            'attachment_mib_per_minute': 2,
                            'account_errors_10m': 1,
                            'account_error_streak': 1,
                            'untrusted_field': 999,
                        },
                        'missing-connection': {'event_rate_5m': 100},
                    }
                }
            }
        ).encode()
        with self._verified():
            await self.gateway_router.register_gateway_node(self._request(register), db=None)
            response = await self.gateway_router.gateway_node_heartbeat('node-load', self._request(heartbeat), db=None)
        self.assertEqual(response['node_id'], 'node-load')
        connection = await self.gateway.get_connection('qq-default')
        self.assertEqual(connection.last_runtime_node_id, 'node-load')
        self.assertEqual(connection.config['runtime_metrics']['event_rate_5m'], 10)
        self.assertNotIn('untrusted_field', connection.config['runtime_metrics'])


class BotGatewayCredentialMigrationTests(TestCase):
    # 完整 alembic upgrade head 链在现有测试基建中没有用例（迁移依赖真实
    # DATABASE_URL），此处按 test_bot_gateway_backend 的既有模式单测本迁移。
    def test_migration_adds_runtime_columns_and_credential_tables(self):
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        from open_webui.migrations.versions import e3f4a5b6c7d8_add_bot_gateway_operations as migration
        from sqlalchemy import Column, MetaData, String, Table, create_engine, inspect

        engine = create_engine('sqlite://')
        metadata = MetaData()
        Table('user', metadata, Column('id', String, primary_key=True))
        Table(
            'bot_gateway_connection',
            metadata,
            Column('id', String, primary_key=True),
            Column('channel', String),
        )
        with engine.begin() as connection:
            metadata.create_all(connection)
            operations = Operations(MigrationContext.configure(connection))
            with (
                patch.object(migration, 'op', operations),
                patch.object(
                    migration,
                    'get_existing_tables',
                    side_effect=lambda: set(inspect(connection).get_table_names()),
                ),
            ):
                migration.upgrade()
                inspector = inspect(connection)
                for table in (
                    'bot_gateway_credential',
                    'bot_gateway_shard',
                    'bot_gateway_node',
                    'bot_gateway_account_checkpoint',
                    'bot_gateway_control_operation',
                ):
                    self.assertIn(table, inspector.get_table_names())
                connection_columns = {column['name'] for column in inspector.get_columns('bot_gateway_connection')}
                for column in (
                    'shard_id',
                    'account_key',
                    'assignment_generation',
                    'last_runtime_node_id',
                    'last_runtime_at',
                ):
                    self.assertIn(column, connection_columns)
                constraints = {
                    constraint['name'] for constraint in inspector.get_unique_constraints('bot_gateway_credential')
                }
                self.assertIn('uq_bot_gateway_credential_account_digest', constraints)

                migration.downgrade()
                inspector = inspect(connection)
                for table in ('bot_gateway_credential', 'bot_gateway_control_operation'):
                    self.assertNotIn(table, inspector.get_table_names())
                connection_columns = {column['name'] for column in inspector.get_columns('bot_gateway_connection')}
                self.assertNotIn('shard_id', connection_columns)
