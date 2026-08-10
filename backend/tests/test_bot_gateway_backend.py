import asyncio
import datetime as dt
import json
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from open_webui.internal.db import Base
from open_webui.models import bot_gateway as gateway_models
from open_webui.models.bot_gateway import (
    BotGatewayBinding,
    BotGatewayBindingCode,
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
from open_webui.models.chats import Chat
from open_webui.models.users import User
from sqlalchemy import Column, String, Table, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


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
        self.gateway = BotGatewayTable()
        await self._seed_identity()

    async def asyncTearDown(self):
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


class BotGatewayMigrationTests(TestCase):
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
