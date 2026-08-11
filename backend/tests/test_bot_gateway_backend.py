import asyncio
import datetime as dt
import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from open_webui.internal.db import Base
from open_webui.models import bot_gateway as gateway_models
from open_webui.models import chats as chat_models
from open_webui.models.bot_gateway import (
    BotGatewayBinding,
    BotGatewayBindingCode,
    BotGatewayBindingHistory,
    BotGatewayBindingError,
    BotGatewayConnection,
    BotGatewayConnectionModel,
    BotGatewayConversation,
    BotGatewayEvent,
    BotGatewayEventModel,
    BotGatewayGroupModel,
    BotGatewayRequestNonce,
    BotGatewayTable,
)
from open_webui.models.chats import Chat, Chats
from open_webui.models.users import User
from sqlalchemy import Column, String, Table, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _enabled_gateway_policy() -> AsyncMock:
    """Both channels switched on, so router tests reach the logic they assert."""
    return AsyncMock(
        return_value={
            'enabled': True,
            'qq_enabled': True,
            'wechat_enabled': True,
            'recommended_model_id': None,
        }
    )


class BotGatewayDatabaseTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name, 'bot-gateway.db').as_posix()
        self.engine = create_async_engine(f'sqlite+aiosqlite:///{database_path}')
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        tables = [
            User.__table__,
            Chat.__table__,
            BotGatewayConnection.__table__,
            BotGatewayBinding.__table__,
            BotGatewayConversation.__table__,
            BotGatewayBindingCode.__table__,
            BotGatewayBindingHistory.__table__,
            BotGatewayRequestNonce.__table__,
            BotGatewayEvent.__table__,
        ]
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
        self.chat_context_patcher = patch.object(chat_models, 'get_async_db_context', test_db_context)
        self.chat_context_patcher.start()
        self.gateway = BotGatewayTable()
        await self._seed_identity()

    async def asyncTearDown(self):
        self.chat_context_patcher.stop()
        self.context_patcher.stop()
        await self.engine.dispose()
        self.temp_dir.cleanup()

    async def _seed_identity(self):
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
                ]
            )
            await session.commit()

    async def test_nonce_is_atomically_single_use_and_expired_rows_are_reclaimable(self):
        nonce = 'atomic-nonce-0000000000000001'
        results = await asyncio.gather(
            self.gateway.claim_request_nonce(nonce, expires_at=int(time.time()) + 600),
            self.gateway.claim_request_nonce(nonce, expires_at=int(time.time()) + 600),
        )
        self.assertEqual(sorted(results), [False, True])

        expired_nonce = 'expired-nonce-00000000000001'
        async with self.sessions() as session:
            session.add(
                BotGatewayRequestNonce(
                    nonce=expired_nonce,
                    expires_at=int(time.time()) - 1,
                    created_at=int(time.time()) - 10,
                )
            )
            await session.commit()

        self.assertTrue(
            await self.gateway.claim_request_nonce(
                expired_nonce,
                expires_at=int(time.time()) + 600,
            )
        )
        async with self.sessions() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(BotGatewayRequestNonce)
                .where(BotGatewayRequestNonce.nonce == expired_nonce)
            )
        self.assertEqual(count, 1)

    async def test_user_connection_creation_is_idempotent_under_concurrency(self):
        connections = await asyncio.gather(
            self.gateway.ensure_user_connection('user-1', 'wechat'),
            self.gateway.ensure_user_connection('user-1', 'wechat'),
        )

        self.assertEqual(connections[0].id, connections[1].id)
        async with self.sessions() as session:
            count = await session.scalar(
                select(func.count()).select_from(BotGatewayConnection).where(
                    BotGatewayConnection.owner_user_id == 'user-1',
                    BotGatewayConnection.channel == 'wechat',
                )
            )
        self.assertEqual(count, 1)

    async def test_personal_connection_only_auto_binds_the_scanned_owner_identity(self):
        now = int(time.time())
        async with self.sessions() as session:
            session.add(
                BotGatewayConnection(
                    id='wechat-user-1',
                    channel='wechat',
                    name='WeChat',
                    enabled=True,
                    status='connected',
                    credentials_configured=True,
                    owner_user_id='user-1',
                    config={'trusted_external_user_id': 'wechat-identity'},
                    created_at=now,
                    updated_at=now,
                )
            )
            # Without the identity the QR login returned there is nobody to trust,
            # so a personal bot must refuse to bind rather than take the first
            # stranger who direct-messages it.
            session.add(
                BotGatewayConnection(
                    id='wechat-user-2',
                    channel='wechat',
                    name='WeChat',
                    enabled=True,
                    status='connected',
                    credentials_configured=True,
                    owner_user_id='user-1',
                    config={},
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.commit()

        binding = await self.gateway.ensure_owner_binding(
            'wechat-user-1',
            'wechat-identity',
            display_name='WeChat User',
        )

        self.assertIsNotNone(binding)
        self.assertEqual(binding.user_id, 'user-1')
        self.assertEqual(binding.external_user_id, 'wechat-identity')
        self.assertTrue(binding.enabled)
        self.assertFalse(binding.blocked)
        self.assertIsNone(
            await self.gateway.ensure_owner_binding(
                'wechat-user-1',
                'different-identity',
                display_name='Unexpected User',
            )
        )
        self.assertIsNone(
            await self.gateway.ensure_owner_binding(
                'wechat-user-2',
                'first-stranger',
                display_name='Stranger',
            )
        )

    async def test_failed_and_stale_events_can_be_retried_without_old_lease_writes(self):
        values = {
            'connection_id': 'qq-default',
            'event_id': 'event-1',
            'request_hash': 'a' * 64,
            'conversation_type': 'private',
            'external_conversation_id': 'external-user',
            'external_sender_id': 'external-user',
            'lease_seconds': 30,
        }
        first, acquired = await self.gateway.claim_event(request_nonce='nonce-1', **values)
        self.assertTrue(acquired)

        active, acquired = await self.gateway.claim_event(request_nonce='nonce-2', **values)
        self.assertFalse(acquired)
        self.assertEqual(active.attempts, 1)

        async with self.sessions() as session:
            await session.execute(
                update(BotGatewayEvent).where(BotGatewayEvent.id == first.id).values(updated_at=int(time.time()) - 31)
            )
            await session.commit()

        retried, acquired = await self.gateway.claim_event(request_nonce='nonce-3', **values)
        self.assertTrue(acquired)
        self.assertEqual(retried.attempts, 2)
        self.assertEqual(retried.request_nonce, 'nonce-3')
        self.assertFalse(await self.gateway.complete_event(first.id, 'nonce-1', {'stale': True}))

        self.assertTrue(await self.gateway.fail_event(first.id, 'nonce-3', 'temporary upstream failure'))
        failed_retry, acquired = await self.gateway.claim_event(request_nonce='nonce-4', **values)
        self.assertTrue(acquired)
        self.assertEqual(failed_retry.attempts, 3)
        response = {'version': '1.0', 'event_id': 'event-1', 'status': 'ok', 'reply': {'text': 'done'}}
        self.assertTrue(await self.gateway.complete_event(first.id, 'nonce-4', response))

        completed, acquired = await self.gateway.claim_event(request_nonce='nonce-5', **values)
        self.assertFalse(acquired)
        self.assertEqual(completed.status, 'completed')
        self.assertEqual(completed.response, response)

    async def test_admin_block_survives_new_codes_but_normal_unbind_can_rebind(self):
        now = int(time.time())
        async with self.sessions() as session:
            session.add(
                BotGatewayBinding(
                    id='binding-1',
                    connection_id='qq-default',
                    user_id='user-1',
                    external_user_id='external-user',
                    enabled=True,
                    blocked=False,
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.commit()

        self.assertTrue(await self.gateway.unbind('binding-1', user_id='user-1'))
        await self.gateway.create_binding_code('user-1', 'a' * 64, 'qq', now + 600)
        rebound = await self.gateway.bind_with_code(
            connection_id='qq-default',
            channel='qq',
            external_user_id='external-user',
            display_name='External User',
            code_hash='a' * 64,
        )
        self.assertTrue(rebound.enabled)
        self.assertFalse(rebound.blocked)
        self.assertFalse(rebound.is_new_binding)

        self.assertTrue(await self.gateway.block_binding('binding-1', blocked_by='user-1'))
        await self.gateway.create_binding_code('user-1', 'b' * 64, 'qq', now + 600)
        with self.assertRaises(BotGatewayBindingError) as raised:
            await self.gateway.bind_with_code(
                connection_id='qq-default',
                channel='qq',
                external_user_id='external-user',
                display_name='External User',
                code_hash='b' * 64,
            )
        self.assertEqual(raised.exception.code, 'identity_blocked')

        async with self.sessions() as session:
            binding = await session.get(BotGatewayBinding, 'binding-1')
            code = await session.scalar(
                select(BotGatewayBindingCode).where(BotGatewayBindingCode.code_hash == 'b' * 64)
            )
        self.assertTrue(binding.blocked)
        self.assertFalse(binding.enabled)
        self.assertIsNone(code.consumed_at)

        self.assertTrue(await self.gateway.unblock_binding('binding-1'))
        unblocked = await self.gateway.bind_with_code(
            connection_id='qq-default',
            channel='qq',
            external_user_id='external-user',
            display_name='External User',
            code_hash='b' * 64,
        )
        self.assertTrue(unblocked.enabled)
        self.assertFalse(unblocked.blocked)
        self.assertFalse(unblocked.is_new_binding)

    async def test_only_the_first_binding_is_marked_new(self):
        now = int(time.time())
        await self.gateway.create_binding_code('user-1', 'c' * 64, 'qq', now + 600)
        first = await self.gateway.bind_with_code(
            connection_id='qq-default',
            channel='qq',
            external_user_id='first-time-user',
            display_name='First Time User',
            code_hash='c' * 64,
        )
        self.assertTrue(first.is_new_binding)

        self.assertTrue(await self.gateway.unbind(first.id, user_id='user-1'))
        await self.gateway.create_binding_code('user-1', 'd' * 64, 'qq', now + 600)
        rebound = await self.gateway.bind_with_code(
            connection_id='qq-default',
            channel='qq',
            external_user_id='first-time-user',
            display_name='First Time User',
            code_hash='d' * 64,
        )
        self.assertFalse(rebound.is_new_binding)

    async def test_cleanup_bounds_old_event_and_nonce_rows(self):
        now = int(time.time())
        async with self.sessions() as session:
            session.add_all(
                [
                    BotGatewayRequestNonce(
                        nonce='old-nonce-000000000000000001',
                        expires_at=now - 1,
                        created_at=now - 10,
                    ),
                    BotGatewayEvent(
                        id='old-event-row',
                        connection_id='qq-default',
                        event_id='old-event',
                        request_hash='f' * 64,
                        request_nonce='old-request-nonce',
                        status='completed',
                        response={'status': 'ok'},
                        attempts=1,
                        received_at=now - 100,
                        completed_at=now - 100,
                        updated_at=now - 100,
                    ),
                ]
            )
            await session.commit()

        deleted = await self.gateway.cleanup_expired_records(
            now=now,
            event_retention_seconds=10,
            force=True,
        )
        self.assertEqual(deleted['nonces'], 1)
        self.assertEqual(deleted['events'], 1)

    async def test_bot_chat_sequence_is_scoped_by_user_channel_and_shanghai_day(self):
        timezone = dt.timezone(dt.timedelta(hours=8))
        day_start = int(dt.datetime(2026, 8, 11, tzinfo=timezone).timestamp())
        day_end = int(dt.datetime(2026, 8, 12, tzinfo=timezone).timestamp())
        async with self.sessions() as session:
            session.add_all(
                [
                    Chat(
                        id='qq-chat-1', user_id='user-1', title='old', chat={'title': 'old'},
                        meta={'source': 'bot_gateway', 'channel': 'qq'},
                        created_at=day_start + 1, updated_at=day_start + 1,
                    ),
                    Chat(
                        id='qq-chat-2', user_id='user-1', title='old', chat={'title': 'old'},
                        meta={'source': 'bot_gateway', 'channel': 'qq'},
                        created_at=day_start + 2, updated_at=day_start + 2,
                    ),
                    Chat(
                        id='wechat-chat-1', user_id='user-1', title='old', chat={'title': 'old'},
                        meta={'source': 'bot_gateway', 'channel': 'wechat'},
                        created_at=day_start + 3, updated_at=day_start + 3,
                    ),
                    Chat(
                        id='other-user-chat', user_id='user-2', title='old', chat={'title': 'old'},
                        meta={'source': 'bot_gateway', 'channel': 'qq'},
                        created_at=day_start + 4, updated_at=day_start + 4,
                    ),
                    Chat(
                        id='previous-day-chat', user_id='user-1', title='old', chat={'title': 'old'},
                        meta={'source': 'bot_gateway', 'channel': 'qq'},
                        created_at=day_start - 1, updated_at=day_start - 1,
                    ),
                    Chat(
                        id='normal-chat', user_id='user-1', title='normal', chat={'title': 'normal'},
                        meta={}, created_at=day_start + 5, updated_at=day_start + 5,
                    ),
                ]
            )
            await session.commit()

            self.assertEqual(
                await Chats.get_next_bot_chat_sequence('user-1', 'qq', day_start, day_end, db=session),
                3,
            )
            self.assertEqual(
                await Chats.get_next_bot_chat_sequence('user-1', 'wechat', day_start, day_end, db=session),
                2,
            )

    async def test_bot_chat_sequence_never_repeats_after_a_same_day_chat_is_deleted(self):
        day_start, day_end = 1_754_928_000, 1_755_014_400
        async with self.sessions() as session:
            session.add_all(
                [
                    Chat(
                        id=f'qq-chat-{index}', user_id='user-1',
                        title=f'🤖QQ-20260811-{index:03d}',
                        chat={'title': f'🤖QQ-20260811-{index:03d}'},
                        meta={'source': 'bot_gateway', 'channel': 'qq'},
                        created_at=day_start + index, updated_at=day_start + index,
                    )
                    for index in (1, 2, 3)
                ]
            )
            await session.commit()

            await session.delete(await session.get(Chat, 'qq-chat-2'))
            await session.commit()

            # A row count would hand out 003 again and collide with the surviving chat.
            self.assertEqual(
                await Chats.get_next_bot_chat_sequence('user-1', 'qq', day_start, day_end, db=session),
                4,
            )


class BotGatewayMigrationTests(TestCase):
    def test_production_revision_is_connected_to_the_bot_gateway_chain(self):
        from open_webui.migrations.versions import b2c3d4e5f6a8_add_bot_gateway_tables as bot_gateway
        from open_webui.migrations.versions import b5e7c9d1a2f3_restore_production_revision as compatibility

        self.assertEqual(compatibility.down_revision, 'a1b2c3d4e5f7')
        self.assertEqual(bot_gateway.down_revision, compatibility.revision)

    def test_credit_log_migration_preserves_existing_history(self):
        from open_webui.migrations.versions import c4d5e6f7a8b9_remove_credit_log_table as migration

        with patch.object(migration, 'op', create=True) as operations:
            migration.upgrade()

        operations.drop_table.assert_not_called()

    def test_fresh_sqlite_schema_has_nonce_uniqueness_block_state_and_cleanup_index(self):
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        from open_webui.migrations.versions import b2c3d4e5f6a8_add_bot_gateway_tables as migration
        from sqlalchemy import MetaData, create_engine, inspect

        engine = create_engine('sqlite://')
        metadata = MetaData()
        Table('user', metadata, Column('id', String, primary_key=True))
        Table('chat', metadata, Column('id', String, primary_key=True))
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
                self.assertIn('bot_gateway_request_nonce', inspector.get_table_names())
                self.assertEqual(
                    inspector.get_pk_constraint('bot_gateway_request_nonce')['constrained_columns'],
                    ['nonce'],
                )
                binding_columns = {column['name']: column for column in inspector.get_columns('bot_gateway_binding')}
                self.assertFalse(binding_columns['blocked']['nullable'])
                event_indexes = {index['name'] for index in inspector.get_indexes('bot_gateway_event')}
                self.assertIn('ix_bot_gateway_event_updated', event_indexes)
                migration.downgrade()
                self.assertNotIn('bot_gateway_request_nonce', inspect(connection).get_table_names())


class BotGatewayRouterSemanticsTests(IsolatedAsyncioTestCase):
    def setUp(self):
        from open_webui.routers import bot_gateway as gateway_router

        self.gateway_router = gateway_router
        self.gateway_router._conversation_locks.clear()

    def test_bot_chat_title_uses_channel_date_and_zero_padded_sequence(self):
        timezone = dt.timezone(dt.timedelta(hours=8))
        created_at = int(dt.datetime(2026, 8, 11, 9, 30, tzinfo=timezone).timestamp())
        self.assertEqual(
            self.gateway_router.format_bot_chat_title('wechat', created_at, 1),
            '🤖微信-20260811-001',
        )
        self.assertEqual(
            self.gateway_router.format_bot_chat_title('qq', created_at, 2),
            '🤖QQ-20260811-002',
        )

    async def test_conversation_lock_skips_the_advisory_lock_outside_postgresql(self):
        opened = []

        @asynccontextmanager
        async def sqlite_session():
            session = SimpleNamespace(
                bind=SimpleNamespace(dialect=SimpleNamespace(name='sqlite')),
                scalar=AsyncMock(),
                execute=AsyncMock(),
                commit=AsyncMock(),
            )
            opened.append(session)
            yield session

        with (
            patch.object(self.gateway_router, 'get_async_db', sqlite_session),
            patch.object(self.gateway_router, 'UVICORN_WORKERS', 4),
        ):
            async with self.gateway_router._conversation_lock('conversation-key'):
                pass

        self.assertEqual(len(opened), 1)
        opened[0].scalar.assert_not_awaited()

    async def test_conversation_lock_holds_and_releases_a_postgres_advisory_lock(self):
        statements = []
        session = SimpleNamespace(
            bind=SimpleNamespace(dialect=SimpleNamespace(name='postgresql')),
            commit=AsyncMock(),
        )

        async def scalar(statement, parameters):
            statements.append((str(statement), parameters))
            return True

        async def execute(statement, parameters):
            statements.append((str(statement), parameters))

        session.scalar = scalar
        session.execute = execute

        @asynccontextmanager
        async def postgres_session():
            yield session

        with (
            patch.object(self.gateway_router, 'get_async_db', postgres_session),
            patch.object(self.gateway_router, 'UVICORN_WORKERS', 4),
        ):
            async with self.gateway_router._conversation_lock('conversation-key'):
                self.assertEqual(len(statements), 1)

        self.assertEqual(len(statements), 2)
        self.assertIn('pg_try_advisory_lock', statements[0][0])
        self.assertIn('pg_advisory_unlock', statements[1][0])
        expected_key = self.gateway_router._advisory_lock_key('conversation-key')
        self.assertEqual(statements[0][1], {'key': expected_key})
        self.assertEqual(statements[1][1], {'key': expected_key})
        self.assertGreaterEqual(expected_key, -(2**63))
        self.assertLess(expected_key, 2**63)

    async def test_conversation_lock_times_out_while_another_holder_keeps_it(self):
        async def hold(started, release):
            async with self.gateway_router._conversation_lock('busy-key'):
                started.set()
                await release.wait()

        started = asyncio.Event()
        release = asyncio.Event()
        holder = asyncio.create_task(hold(started, release))
        await started.wait()
        try:
            with self.assertRaises(self.gateway_router._ConversationLockTimeoutError):
                async with self.gateway_router._conversation_lock('busy-key', timeout=0.05):
                    pass
        finally:
            release.set()
            await holder

    def test_bot_media_url_uses_the_mounted_api_v1_route(self):
        with patch.dict(
            os.environ,
            {
                'BOT_GATEWAY_HMAC_SECRET': 'a' * 32,
                'BOT_GATEWAY_PUBLIC_BASE_URL': 'https://chat.example.test',
            },
        ):
            media_url = self.gateway_router._media_url('file-id', 'user-id')

        self.assertTrue(
            media_url.startswith(
                'https://chat.example.test/api/v1/internal/bot-gateway/media/'
            )
        )

    def test_bot_commands_accept_chinese_aliases_and_arguments(self):
        cases = {
            '/帮助': ('help', None),
            '/指令': ('help', None),
            '/状态': ('status', None),
            '/积分': ('points', None),
            '/模型列表': ('models', None),
            '/模型 gpt-test': ('model', 'gpt-test'),
            '/模型 默认': ('model', 'default'),
            '/新对话': ('new', None),
            '/历史': ('history', None),
            '/会话 conversation-id': ('conversation', 'conversation-id'),
            '/绑定 ABC123': ('bind', 'ABC123'),
            '/解绑 确认': ('unbind', 'confirm'),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(self.gateway_router.parse_bot_gateway_command(text), expected)

    def test_model_commands_use_visible_names_and_accept_numeric_selection(self):
        models = [
            {'id': 'internal-model-id', 'name': 'Ryan 智能助手'},
            {'id': 'second-model-id', 'name': '论文分析模型'},
        ]

        self.assertEqual(self.gateway_router._model_display_name(models[0]), 'Ryan 智能助手')
        self.assertEqual(self.gateway_router._model_name_for_id('internal-model-id', models), 'Ryan 智能助手')
        self.assertEqual(self.gateway_router._model_for_argument('2', models), models[1])
        self.assertEqual(self.gateway_router._model_for_argument('论文分析模型', models), models[1])
        self.assertEqual(self.gateway_router._model_for_argument('internal-model-id', models), models[0])
        self.assertEqual(self.gateway_router._model_display_name({'id': 'hidden-id'}), '未命名模型')
        self.assertEqual(self.gateway_router._model_name_for_id('missing-id', models), '未命名模型')

    async def test_every_successful_binding_returns_privacy_tutorial_and_command_messages(self):
        event = self.gateway_router.InboundEvent.model_validate(
            {
                'version': '1.0',
                'event_id': 'bind-event',
                'occurred_at': dt.datetime.now(dt.UTC).isoformat(),
                'channel': 'qq',
                'connection_id': 'qq-default',
                'conversation': {'type': 'private', 'id': 'external-user'},
                'sender': {'id': 'external-user', 'name': 'New User'},
                'message': {'text': '/绑定 ABC123'},
                'attachments': [],
            }
        )

        with patch.object(
            self.gateway_router.BotGateway,
            'bind_with_code',
            AsyncMock(return_value=SimpleNamespace(is_new_binding=True)),
        ):
            reply = await self.gateway_router._handle_command(
                SimpleNamespace(), event, None, 'bind', 'ABC123'
            )

        self.assertIsInstance(reply, list)
        self.assertEqual(len(reply), 3)
        self.assertTrue(reply[0].startswith('【隐私协议】'))
        self.assertTrue(reply[1].startswith('【使用教程】'))
        self.assertTrue(reply[2].startswith('【常用指令】'))
        wire = self.gateway_router._wire_response(event.event_id, reply)
        self.assertEqual(wire['reply']['messages'], reply)
        self.assertIn('/模型 <序号或名称>', wire['reply']['text'])

        with patch.object(
            self.gateway_router.BotGateway,
            'bind_with_code',
            AsyncMock(return_value=SimpleNamespace(is_new_binding=False)),
        ):
            rebound_reply = await self.gateway_router._handle_command(
                SimpleNamespace(), event, None, 'bind', 'NEW456'
            )

        self.assertEqual(rebound_reply, reply)

    async def test_history_uses_chat_titles_and_numeric_selection(self):
        now = int(time.time())
        target = SimpleNamespace(
            id='conversation-long-opaque-id',
            chat_id='chat-long-opaque-id',
            model_id='gpt-test',
            created_at=now,
        )
        current = SimpleNamespace(id='current-conversation', chat_id=None, model_id=None)
        binding = SimpleNamespace(id='binding-1', user_id='user-1')
        user = SimpleNamespace(id='user-1', role='user')
        event = self.gateway_router.InboundEvent.model_validate(
            {
                'version': '1.0',
                'event_id': 'history-event',
                'occurred_at': dt.datetime.now(dt.UTC).isoformat(),
                'channel': 'wechat',
                'connection_id': 'wechat-default',
                'conversation': {'type': 'private', 'id': 'external-user'},
                'sender': {'id': 'external-user'},
                'message': {'text': '/历史'},
                'attachments': [],
            }
        )
        entries = [(target, '🤖微信-20260811-001')]

        with (
            patch.object(self.gateway_router.Users, 'get_user_by_id', AsyncMock(return_value=user)),
            patch.object(self.gateway_router.BotGateway, 'get_or_create_conversation', AsyncMock(return_value=current)),
            patch.object(
                self.gateway_router,
                '_conversation_history_entries',
                AsyncMock(return_value=entries),
            ) as history_entries,
            patch.object(self.gateway_router.BotGateway, 'update_conversation', AsyncMock()) as update_conversation,
        ):
            history = await self.gateway_router._handle_command(
                SimpleNamespace(), event, binding, 'history', None
            )
            switched = await self.gateway_router._handle_command(
                SimpleNamespace(), event, binding, 'conversation', '1'
            )

        self.assertIn('1. 🤖微信-20260811-001', history)
        self.assertNotIn('conversation-long-opaque-id', history)
        self.assertNotIn('chat-long-opaque-id', history)
        self.assertEqual(switched, '已切换到“🤖微信-20260811-001”，请继续发送消息。')
        history_entries.assert_awaited_with(user.id, binding.id, limit=20)
        update_conversation.assert_awaited_with(
            current.id,
            {'chat_id': target.chat_id, 'model_id': target.model_id},
        )

    def test_bot_conversation_inherits_latest_document_as_full_context(self):
        old_pdf = {
            'type': 'file',
            'id': 'old-pdf',
            'url': 'old-pdf',
            'name': 'old.pdf',
            'content_type': 'application/pdf',
        }
        latest_pdf = {
            'type': 'file',
            'id': 'latest-pdf',
            'url': 'latest-pdf',
            'name': 'latest.pdf',
            'content_type': 'application/pdf',
        }
        image = {
            'type': 'image',
            'id': 'current-image',
            'url': 'current-image',
            'name': 'current.png',
            'content_type': 'image/png',
        }
        history = [
            {'role': 'user', 'content': 'first file', 'files': [old_pdf]},
            {'role': 'assistant', 'content': 'received'},
            {'role': 'user', 'content': 'replacement file', 'files': [latest_pdf]},
            {'role': 'assistant', 'content': 'received'},
        ]

        inherited = self.gateway_router._conversation_context_files(history, [image])
        self.assertEqual([item['id'] for item in inherited], ['current-image', 'latest-pdf'])
        self.assertNotIn('context', inherited[0])
        self.assertEqual(inherited[1]['context'], 'full')

        replacement = self.gateway_router._conversation_context_files(history, [old_pdf])
        self.assertEqual([item['id'] for item in replacement], ['old-pdf'])
        self.assertEqual(replacement[0]['context'], 'full')

    async def test_duplicate_nonce_returns_409_before_payload_parsing(self):
        request = SimpleNamespace(form=AsyncMock())
        with (
            patch.object(
                self.gateway_router,
                '_verify_internal_request',
                AsyncMock(return_value=('duplicate-nonce-0000000001', 'hash', b'')),
            ),
            patch.object(self.gateway_router.BotGateway, 'claim_request_nonce', AsyncMock(return_value=False)),
        ):
            with self.assertRaises(self.gateway_router.HTTPException) as raised:
                await self.gateway_router.receive_event(request, db=None)
        self.assertEqual(raised.exception.status_code, 409)
        request.form.assert_not_awaited()

    async def test_unbound_group_command_is_strictly_silent(self):
        now = int(time.time())
        payload = {
            'version': '1.0',
            'event_id': 'group-event',
            'occurred_at': dt.datetime.now(dt.UTC).isoformat(),
            'channel': 'qq',
            'connection_id': 'qq-default',
            'conversation': {'type': 'group', 'id': 'group-1', 'name': 'Group'},
            'sender': {'id': 'unbound-user', 'name': 'Unbound'},
            'message': {'text': '/help', 'mentions_bot': True},
            'attachments': [],
        }
        request = SimpleNamespace(form=AsyncMock(return_value={'event': json.dumps(payload)}))
        connection = BotGatewayConnectionModel(
            id='qq-default',
            channel='qq',
            name='QQ',
            enabled=True,
            status='connected',
            created_at=now,
            updated_at=now,
        )
        event_record = BotGatewayEventModel(
            id='event-row',
            connection_id='qq-default',
            event_id='group-event',
            request_hash='a' * 64,
            request_nonce='new-nonce-0000000000000001',
            status='processing',
            conversation_type='group',
            external_conversation_id='group-1',
            external_sender_id='unbound-user',
            attempts=1,
            received_at=now,
            updated_at=now,
        )
        group = BotGatewayGroupModel(
            id='group-row',
            connection_id='qq-default',
            external_group_id='group-1',
            name='Group',
            allowed=True,
            created_at=now,
            updated_at=now,
        )
        with (
            patch.object(
                self.gateway_router,
                '_verify_internal_request',
                AsyncMock(return_value=(event_record.request_nonce, 'hash', b'')),
            ),
            patch.object(self.gateway_router.BotGateway, 'claim_request_nonce', AsyncMock(return_value=True)),
            patch.object(self.gateway_router.BotGateway, 'cleanup_expired_records', AsyncMock(return_value={})),
            patch.object(self.gateway_router.BotGateway, 'get_connection', AsyncMock(return_value=connection)),
            patch.object(self.gateway_router.BotGateway, 'claim_event', AsyncMock(return_value=(event_record, True))),
            patch.object(self.gateway_router.BotGateway, 'upsert_group', AsyncMock(return_value=group)),
            patch.object(self.gateway_router.BotGateway, 'get_enabled_binding', AsyncMock(return_value=None)),
            patch.object(self.gateway_router.BotGateway, 'complete_event', AsyncMock(return_value=True)),
            patch.object(self.gateway_router, '_handle_command', AsyncMock()) as handle_command,
        ):
            response = await self.gateway_router.receive_event(request, db=None)

        self.assertEqual(response['status'], 'ignored')
        self.assertIsNone(response['reply'])
        handle_command.assert_not_awaited()
        self.assertFalse(self.gateway_router._conversation_locks)

    async def test_personal_private_message_auto_binds_before_command_handling(self):
        now = int(time.time())
        payload = {
            'version': '1.0',
            'event_id': 'personal-private-event',
            'occurred_at': dt.datetime.now(dt.UTC).isoformat(),
            'channel': 'wechat',
            'connection_id': 'wechat-user-1',
            'conversation': {'type': 'private', 'id': 'wechat-identity'},
            'sender': {'id': 'wechat-identity', 'name': 'WeChat User'},
            'message': {'text': '/状态'},
            'attachments': [],
        }
        request = SimpleNamespace(form=AsyncMock(return_value={'event': json.dumps(payload)}))
        connection = BotGatewayConnectionModel(
            id='wechat-user-1',
            channel='wechat',
            name='WeChat',
            enabled=True,
            status='connected',
            credentials_configured=True,
            owner_user_id='user-1',
            config={'trusted_external_user_id': 'wechat-identity'},
            created_at=now,
            updated_at=now,
        )
        event_record = BotGatewayEventModel(
            id='personal-private-event-row',
            connection_id=connection.id,
            event_id=payload['event_id'],
            request_hash='b' * 64,
            request_nonce='personal-private-nonce-000001',
            status='processing',
            conversation_type='private',
            external_conversation_id='wechat-identity',
            external_sender_id='wechat-identity',
            attempts=1,
            received_at=now,
            updated_at=now,
        )
        binding = SimpleNamespace(
            id='auto-binding',
            user_id='user-1',
            external_user_id='wechat-identity',
        )
        auto_bind = AsyncMock(return_value=binding)
        handle_command = AsyncMock(return_value='已自动绑定')
        with (
            patch.object(
                self.gateway_router,
                '_verify_internal_request',
                AsyncMock(return_value=(event_record.request_nonce, 'hash', b'')),
            ),
            patch.object(self.gateway_router, '_gateway_policy', _enabled_gateway_policy()),
            patch.object(self.gateway_router.BotGateway, 'claim_request_nonce', AsyncMock(return_value=True)),
            patch.object(self.gateway_router.BotGateway, 'cleanup_expired_records', AsyncMock(return_value={})),
            patch.object(self.gateway_router.BotGateway, 'get_connection', AsyncMock(return_value=connection)),
            patch.object(self.gateway_router.BotGateway, 'claim_event', AsyncMock(return_value=(event_record, True))),
            patch.object(self.gateway_router.BotGateway, 'get_enabled_binding', AsyncMock(return_value=None)),
            patch.object(self.gateway_router.BotGateway, 'ensure_owner_binding', auto_bind),
            patch.object(self.gateway_router.BotGateway, 'complete_event', AsyncMock(return_value=True)),
            patch.object(self.gateway_router, '_handle_command', handle_command),
        ):
            response = await self.gateway_router.receive_event(request, db=None)

        auto_bind.assert_awaited_once_with(
            connection.id,
            'wechat-identity',
            display_name='WeChat User',
        )
        self.assertIs(handle_command.await_args.args[2], binding)
        self.assertEqual(response['reply']['text'], '已自动绑定')
        self.assertFalse(self.gateway_router._conversation_locks)

    async def test_personal_private_message_from_an_untrusted_sender_is_ignored(self):
        now = int(time.time())
        payload = {
            'version': '1.0',
            'event_id': 'personal-private-stranger',
            'occurred_at': dt.datetime.now(dt.UTC).isoformat(),
            'channel': 'wechat',
            'connection_id': 'wechat-user-1',
            'conversation': {'type': 'private', 'id': 'stranger-identity'},
            'sender': {'id': 'stranger-identity', 'name': 'Stranger'},
            'message': {'text': '/状态'},
            'attachments': [],
        }
        request = SimpleNamespace(form=AsyncMock(return_value={'event': json.dumps(payload)}))
        connection = BotGatewayConnectionModel(
            id='wechat-user-1',
            channel='wechat',
            name='WeChat',
            enabled=True,
            status='connected',
            credentials_configured=True,
            owner_user_id='user-1',
            config={'trusted_external_user_id': 'wechat-identity'},
            created_at=now,
            updated_at=now,
        )
        event_record = BotGatewayEventModel(
            id='personal-private-stranger-row',
            connection_id=connection.id,
            event_id=payload['event_id'],
            request_hash='c' * 64,
            request_nonce='personal-private-nonce-000002',
            status='processing',
            conversation_type='private',
            external_conversation_id='stranger-identity',
            external_sender_id='stranger-identity',
            attempts=1,
            received_at=now,
            updated_at=now,
        )
        auto_bind = AsyncMock()
        handle_command = AsyncMock()
        with (
            patch.object(
                self.gateway_router,
                '_verify_internal_request',
                AsyncMock(return_value=(event_record.request_nonce, 'hash', b'')),
            ),
            patch.object(self.gateway_router, '_gateway_policy', _enabled_gateway_policy()),
            patch.object(self.gateway_router.BotGateway, 'claim_request_nonce', AsyncMock(return_value=True)),
            patch.object(self.gateway_router.BotGateway, 'cleanup_expired_records', AsyncMock(return_value={})),
            patch.object(self.gateway_router.BotGateway, 'get_connection', AsyncMock(return_value=connection)),
            patch.object(self.gateway_router.BotGateway, 'claim_event', AsyncMock(return_value=(event_record, True))),
            patch.object(self.gateway_router.BotGateway, 'get_enabled_binding', AsyncMock(return_value=None)),
            patch.object(self.gateway_router.BotGateway, 'ensure_owner_binding', auto_bind),
            patch.object(self.gateway_router.BotGateway, 'complete_event', AsyncMock(return_value=True)),
            patch.object(self.gateway_router, '_handle_command', handle_command),
        ):
            response = await self.gateway_router.receive_event(request, db=None)

        auto_bind.assert_not_awaited()
        handle_command.assert_not_awaited()
        self.assertTrue(response['status'] == 'ignored')
        self.assertIsNone(response['reply'])

    async def test_logout_clears_backend_credential_flag_after_sidecar_success(self):
        now = int(time.time())
        connection = BotGatewayConnectionModel(
            id='qq-default',
            channel='qq',
            name='QQ',
            enabled=True,
            status='connected',
            credentials_configured=True,
            created_at=now,
            updated_at=now,
        )
        logged_out = connection.model_copy(update={'status': 'logged_out'})
        update_connection = AsyncMock(return_value=logged_out)
        with (
            patch.object(self.gateway_router, '_get_connection_or_404', AsyncMock(return_value=connection)),
            patch.object(
                self.gateway_router,
                '_sidecar_request',
                AsyncMock(return_value={'version': '1.0', 'connection': {'status': 'logged_out'}}),
            ),
            patch.object(self.gateway_router, '_sync_connection', AsyncMock(return_value=logged_out)),
            patch.object(self.gateway_router.BotGateway, 'update_connection', update_connection),
        ):
            response = await self.gateway_router.logout('qq-default', user=SimpleNamespace(id='admin-1'))

        self.assertEqual(response.status_code, 204)
        values = update_connection.await_args.args[1]
        self.assertFalse(values['credentials_configured'])

    async def test_sidecar_account_label_marks_a_completed_wechat_login_as_configured(self):
        now = int(time.time())
        connection = BotGatewayConnectionModel(
            id='wechat-default',
            channel='wechat',
            name='WeChat',
            enabled=True,
            status='awaiting_scan',
            credentials_configured=False,
            created_at=now,
            updated_at=now,
        )
        remote = {
            'status': 'connected',
            'accountLabel': '797045aa61de@im.bot',
            'detail': 'Channel is already connected',
        }
        updated = connection.model_copy(
            update={
                'status': 'connected',
                'credentials_configured': True,
                'account_name': remote['accountLabel'],
            }
        )
        update_connection = AsyncMock(return_value=updated)
        with patch.object(self.gateway_router.BotGateway, 'update_connection', update_connection):
            result = await self.gateway_router._sync_connection(connection, remote)

        values = update_connection.await_args.args[1]
        self.assertTrue(values['credentials_configured'])
        self.assertFalse(update_connection.await_args.kwargs['touch_updated_at'])
        self.assertTrue(self.gateway_router._connection_response(result, remote)['configured'])

    async def test_status_refresh_does_not_cancel_background_qq_login(self):
        now = int(time.time())
        connection = BotGatewayConnectionModel(
            id='bot-qq-user-1',
            channel='qq',
            name='QQ',
            enabled=True,
            status='logged_out',
            credentials_configured=True,
            created_at=now,
            updated_at=now,
        )
        connected = connection.model_copy(update={'status': 'connected'})
        with (
            patch.object(
                self.gateway_router,
                '_sidecar_request',
                AsyncMock(return_value={'version': '1.0', 'connection': {'status': 'connected'}}),
            ),
            patch.object(
                self.gateway_router.BotGateway,
                'get_connection',
                AsyncMock(return_value=connection),
            ),
            patch.object(
                self.gateway_router,
                '_sync_connection',
                AsyncMock(return_value=connected),
            ) as sync_connection,
        ):
            await self.gateway_router._finish_background_login(connection.id, now)

        sync_connection.assert_awaited_once_with(connection, {'status': 'connected'})

    async def test_admin_connections_include_owner_identity_for_saved_user_bot(self):
        now = int(time.time())
        connection = BotGatewayConnectionModel(
            id='bot-qq-user-1',
            channel='qq',
            name='QQ',
            enabled=True,
            status='degraded',
            credentials_configured=True,
            account_id='1905398424',
            owner_user_id='user-1',
            created_at=now,
            updated_at=now,
        )
        owner = SimpleNamespace(
            id='user-1',
            name='Test User',
            username='tester',
            email='user@example.com',
        )
        with (
            patch.object(
                self.gateway_router.BotGateway,
                'list_connections',
                AsyncMock(return_value=[connection]),
            ),
            patch.object(
                self.gateway_router.Users,
                'get_user_by_id',
                AsyncMock(return_value=owner),
            ),
            patch.object(self.gateway_router, '_env_enabled', return_value=False),
        ):
            response = await self.gateway_router.get_connections(
                user=SimpleNamespace(id='admin-1'),
                db=SimpleNamespace(),
            )

        self.assertEqual(len(response), 1)
        self.assertEqual(response[0]['owner_user_id'], 'user-1')
        self.assertEqual(response[0]['owner_name'], 'Test User')
        self.assertEqual(response[0]['owner_username'], 'tester')
        self.assertEqual(response[0]['owner_email'], 'user@example.com')
        self.assertTrue(response[0]['credentials_configured'])

    async def test_admin_connections_fall_back_to_database_when_sidecar_is_unavailable(self):
        now = int(time.time())
        connection = BotGatewayConnectionModel(
            id='bot-qq-user-1',
            channel='qq',
            name='QQ',
            enabled=True,
            status='degraded',
            credentials_configured=True,
            owner_user_id='user-1',
            created_at=now,
            updated_at=now,
        )
        owner = SimpleNamespace(name='Test User', username='tester', email='user@example.com')
        with (
            patch.object(
                self.gateway_router.BotGateway,
                'list_connections',
                AsyncMock(return_value=[connection]),
            ),
            patch.object(
                self.gateway_router.Users,
                'get_user_by_id',
                AsyncMock(return_value=owner),
            ),
            patch.object(self.gateway_router, '_env_enabled', return_value=True),
            patch.object(
                self.gateway_router,
                '_sidecar_request',
                AsyncMock(side_effect=self.gateway_router.HTTPException(status_code=503)),
            ),
        ):
            response = await self.gateway_router.get_connections(
                user=SimpleNamespace(id='admin-1'),
                db=SimpleNamespace(),
            )

        self.assertEqual(response[0]['id'], connection.id)
        self.assertEqual(response[0]['owner_name'], 'Test User')
        self.assertTrue(response[0]['credentials_configured'])

    async def test_conversation_lock_registry_releases_entries_after_waiters_finish(self):
        active = 0
        maximum_active = 0

        async def worker():
            nonlocal active, maximum_active
            async with self.gateway_router._conversation_lock('same-conversation'):
                active += 1
                maximum_active = max(maximum_active, active)
                await asyncio.sleep(0)
                active -= 1

        await asyncio.gather(worker(), worker(), worker())
        self.assertEqual(maximum_active, 1)
        self.assertFalse(self.gateway_router._conversation_locks)
