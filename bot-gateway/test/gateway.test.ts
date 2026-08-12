import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { chunkText } from '../src/chunk.js';
import { RyanAiGateway, type ConnectionLoadSnapshot } from '../src/gateway.js';
import { FairConnectionQueue, KeyedSerialQueue, QueueAdmissionError } from '../src/queue.js';
import { RyanAiTransportError, type RyanAiTransport } from '../src/ryanai-client.js';
import { buildConnectionLoadHeartbeat } from '../src/runtime.js';
import { GatewayStateStore } from '../src/state.js';
import { inboundEvent, quietLogger, tempDataDir, testConfig } from './helpers.js';

test('a conversation queue drops entries that wait past their bound instead of stalling', async () => {
	const queue = new KeyedSerialQueue(100, 25);
	let releaseHead!: () => void;
	const head = queue.run('conversation', () => new Promise<void>((resolve) => {
		releaseHead = resolve;
	}));

	await assert.rejects(
		() => queue.run('conversation', async () => 'never runs'),
		/queue_wait_timeout/
	);

	// The timed-out entry must not let anything overtake the task still running.
	let secondStarted = false;
	const second = queue.run('conversation', async () => {
		secondStarted = true;
		return 'ran';
	});
	assert.equal(secondStarted, false);
	releaseHead();
	await head;
	assert.equal(await second, 'ran');
});

test('a full conversation queue rejects rather than growing without bound', async () => {
	const queue = new KeyedSerialQueue(2);
	let releaseHead!: () => void;
	const head = queue.run('conversation', () => new Promise<void>((resolve) => {
		releaseHead = resolve;
	}));
	const queued = queue.run('conversation', async () => undefined);

	await assert.rejects(
		() => queue.run('conversation', async () => undefined),
		/queue_capacity_exceeded/
	);
	releaseHead();
	await Promise.all([head, queued]);
});

test('the global queue gives a quiet connection a turn between noisy connection tasks', async () => {
	const queue = new FairConnectionQueue({
		maxGlobalActive: 1,
		maxConnectionActive: 1,
		maxGlobalQueued: 10,
		maxConnectionQueued: 10,
		maxQueuedBytes: 1_000,
		maxWaitMs: 1_000
	});
	const order: string[] = [];
	let releaseHead!: () => void;
	const head = queue.run('noisy', 1, () => new Promise<void>((resolve) => {
		order.push('noisy-0');
		releaseHead = resolve;
	}));
	const noisyOne = queue.run('noisy', 1, async () => { order.push('noisy-1'); });
	const noisyTwo = queue.run('noisy', 1, async () => { order.push('noisy-2'); });
	const quiet = queue.run('quiet', 1, async () => { order.push('quiet-0'); });

	releaseHead();
	await Promise.all([head, noisyOne, noisyTwo, quiet]);
	assert.deepEqual(order, ['noisy-0', 'noisy-1', 'quiet-0', 'noisy-2']);
});

test('the global queue enforces queued byte capacity and drains cleanly', async () => {
	const queue = new FairConnectionQueue({
		maxGlobalActive: 1,
		maxConnectionActive: 1,
		maxGlobalQueued: 10,
		maxConnectionQueued: 10,
		maxQueuedBytes: 10,
		maxWaitMs: 1_000
	});
	let releaseHead!: () => void;
	const head = queue.run('head', 100, () => new Promise<void>((resolve) => { releaseHead = resolve; }));
	const queued = queue.run('queued', 6, async () => undefined);
	await assert.rejects(
		() => queue.run('overflow', 5, async () => undefined),
		(error: unknown) => error instanceof QueueAdmissionError && error.code === 'queue_overloaded'
	);
	queue.stopAccepting();
	await assert.rejects(
		() => queue.run('late', 1, async () => undefined),
		(error: unknown) => error instanceof QueueAdmissionError && error.code === 'gateway_draining'
	);
	releaseHead();
	await Promise.all([head, queued]);
	assert.equal(await queue.waitForIdle(100), true);
});

test('text chunking is unicode-safe and preserves the original reply', () => {
	const input = '第一段。第二段😀第三段。第四段';
	const chunks = chunkText(input, 6);
	assert.equal(chunks.join(''), input);
	assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 6));
});

test('duplicate event IDs call RyanAI once and reuse the reply', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let calls = 0;
	const transport: RyanAiTransport = {
		async send() {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { text: 'a response longer than one chunk' };
		}
	};
	const gateway = new RyanAiGateway(config, state, transport, quietLogger());
	const event = inboundEvent();
	const [left, right] = await Promise.all([gateway.handle(event), gateway.handle(event)]);
	assert.equal(calls, 1);
	assert.deepEqual(left.chunks, right.chunks);
	assert.ok(left.chunks.every((chunk) => Array.from(chunk).length <= 10));

	const replay = await gateway.handle(event);
	assert.equal(calls, 1);
	assert.equal(replay.replayed, true);
	await rm(dataDir, { recursive: true, force: true });
});

test('connection load snapshots expose decayed event, processing, attachment and error metrics', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let calls = 0;
	const gateway = new RyanAiGateway(
		config,
		state,
		{
			async send() {
				calls += 1;
				if (calls === 1) throw new Error('deterministic account failure');
				return { text: 'ok' };
			}
		},
		quietLogger()
	);
	await gateway.handle(inboundEvent({
		eventId: 'load-failed',
		attachments: [{
			id: 'load-file', fileName: 'load.bin', contentType: 'application/octet-stream',
			bytes: Buffer.alloc(1024 * 1024)
		}]
	}));
	let snapshot = gateway.loadSnapshot();
	assert.equal(snapshot['wechat-default']?.account_errors_10m, 1);
	assert.equal(snapshot['wechat-default']?.account_error_streak, 0);
	assert.ok((snapshot['wechat-default']?.attachment_mib_per_minute ?? 0) > 0);
	await gateway.handle(inboundEvent({ eventId: 'load-success' }));
	snapshot = gateway.loadSnapshot();
	assert.equal(snapshot['wechat-default']?.account_error_streak, 0);
	assert.ok((snapshot['wechat-default']?.event_rate_5m ?? 0) > 0);
	assert.ok((snapshot['wechat-default']?.processing_seconds_per_minute ?? 0) >= 0);
	await state.close();
	await rm(dataDir, { recursive: true, force: true });
});

test('only deterministic account failures build the scheduler isolation streak', () => {
	const loads = {
		'qq-default': {
			event_rate_5m: 1,
			event_rate_30m: 1,
			processing_seconds_per_minute: 0,
			processing_seconds_per_minute_30m: 0,
			attachment_mib_per_minute: 0,
			attachment_mib_per_minute_30m: 0,
			account_errors_10m: 2,
			account_error_streak: 0
		}
	};
	const streaks = new Map<string, number>();
	const transient = {
		id: 'qq-default', channel: 'qq' as const, enabled: true, status: 'degraded' as const,
		updatedAt: new Date().toISOString(), detail: 'RyanAI request timed out'
	};
	buildConnectionLoadHeartbeat(loads, [transient], streaks);
	assert.equal(loads['qq-default'].account_error_streak, 0);

	const deterministic = { ...transient, status: 'unavailable' as const, detail: 'This bot account is already bound to another connection' };
	buildConnectionLoadHeartbeat(loads, [deterministic], streaks);
	buildConnectionLoadHeartbeat(loads, [deterministic], streaks);
	buildConnectionLoadHeartbeat(loads, [deterministic], streaks);
	assert.equal(loads['qq-default'].account_error_streak, 3);

	buildConnectionLoadHeartbeat(loads, [{ ...transient, status: 'connected' as const }], streaks);
	assert.equal(loads['qq-default'].account_error_streak, 0);

	const emptyLoads: Record<string, ConnectionLoadSnapshot> = {};
	buildConnectionLoadHeartbeat(emptyLoads, [{ ...deterministic, id: 'qq-without-events' }], streaks);
	assert.equal(emptyLoads['qq-without-events']?.account_error_streak, 1);
	assert.equal(emptyLoads['qq-without-events']?.event_rate_5m, 0);
});

test('abandoned processing events are reclaimable after the short processing lease', async () => {
	const dataDir = await tempDataDir();
	const state = new GatewayStateStore(dataDir, 24 * 60 * 60 * 1000);
	await state.initialize();

	assert.deepEqual(await state.claimEvent('abandoned-event', 1_000), { status: 'new' });
	assert.deepEqual(await state.claimEvent('abandoned-event', 1_000 + 15 * 60 * 1000 + 1), {
		status: 'new'
	});
	await rm(dataDir, { recursive: true, force: true });
});

test('SQLite preserves SQL credential presence across store restart', async () => {
	const dataDir = await tempDataDir();
	let state = new GatewayStateStore(dataDir, 60_000);
	await state.initialize();
	await state.upsertConnection({
		id: 'qq-sql-owned',
		channel: 'qq',
		enabled: true,
		status: 'logged_out',
		shardId: 'qq-shard-000',
		assignmentGeneration: 3,
		credentialsConfigured: true,
		updatedAt: new Date().toISOString()
	});
	await state.close();
	state = new GatewayStateStore(dataDir, 60_000);
	await state.initialize();
	assert.equal((await state.getConnection('qq-sql-owned'))?.credentialsConfigured, true);
	assert.equal((await state.getConnection('qq-sql-owned'))?.assignmentGeneration, 3);
	await state.close();
	await rm(dataDir, { recursive: true, force: true });
});

test('event IDs are isolated across channel connections', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let calls = 0;
	const gateway = new RyanAiGateway(
		config,
		state,
		{
			async send(event) {
				calls += 1;
				return { text: event.connectionId };
			}
		},
		quietLogger()
	);

	const wechat = await gateway.handle(inboundEvent({ eventId: 'shared-id' }));
	const qq = await gateway.handle(
		inboundEvent({ channel: 'qq', connectionId: 'qq-default', eventId: 'shared-id' })
	);

	assert.equal(calls, 2);
	assert.equal(wechat.chunks.join(''), 'wechat-default');
	assert.equal(qq.chunks.join(''), 'qq-default');
	await rm(dataDir, { recursive: true, force: true });
});

test('backend message groups remain separate gateway reply chunks', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { replyChunkChars: { wechat: 100, qq: 100 } });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	const gateway = new RyanAiGateway(
		config,
		state,
		{
			async send() {
				return {
					text: '隐私协议\n\n使用教程\n\n常用指令',
					messages: ['隐私协议', '使用教程', '常用指令']
				};
			}
		},
		quietLogger()
	);

	const reply = await gateway.handle(inboundEvent({ eventId: 'multi-message-reply' }));
	assert.deepEqual(reply.chunks, ['隐私协议', '使用教程', '常用指令']);
	await rm(dataDir, { recursive: true, force: true });
});

test('messages in the same conversation are serialized', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let active = 0;
	let maxActive = 0;
	const transport: RyanAiTransport = {
		async send() {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 15));
			active -= 1;
			return { text: 'ok' };
		}
	};
	const gateway = new RyanAiGateway(config, state, transport, quietLogger());
	await Promise.all([
		gateway.handle(inboundEvent({ eventId: 'serial-1' })),
		gateway.handle(inboundEvent({ eventId: 'serial-2' }))
	]);
	assert.equal(maxActive, 1);
});

test('backend failure remains handled and returns only the safe error', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	const transport: RyanAiTransport = {
		async send() {
			throw new Error('upstream leaked detail');
		}
	};
	const lines: string[] = [];
	const gateway = new RyanAiGateway(config, state, transport, quietLogger(lines));
	const reply = await gateway.handle(inboundEvent());
	assert.equal(reply.handled, true);
	assert.equal(reply.isError, true);
	assert.equal(reply.chunks.join(''), 'SAFE ERROR');
	assert.equal(JSON.stringify(lines).includes('upstream leaked detail'), false);
});

test('transient RyanAI failures release the event claim for a later redelivery', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let calls = 0;
	const gateway = new RyanAiGateway(
		config,
		state,
		{
			async send() {
				calls += 1;
				if (calls === 1) throw new RyanAiTransportError('http_503');
				return { text: 'recovered' };
			}
		},
		quietLogger()
	);
	const event = inboundEvent({ eventId: 'transient-redelivery' });

	const failed = await gateway.handle(event);
	const recovered = await gateway.handle(event);

	assert.equal(failed.isError, true);
	assert.equal(recovered.chunks.join(''), 'recovered');
	assert.equal(calls, 2);
	await rm(dataDir, { recursive: true, force: true });
});

test('a stale fence becomes an ignored reply and stops the producing shard', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let fencedShard: string | undefined;
	const gateway = new RyanAiGateway(
		config,
		state,
		{ async send() { throw new RyanAiTransportError('stale_fence'); } },
		quietLogger()
	);
	gateway.onStaleFence(async (shardId) => { fencedShard = shardId; });
	const reply = await gateway.handle(inboundEvent({
		eventId: 'stale-fence-event',
		shardId: 'wechat-shard-000',
		nodeId: 'node-old',
		leaseEpoch: 1,
		assignmentGeneration: 2
	}));
	assert.equal(reply.reason, 'ignored');
	assert.deepEqual(reply.chunks, []);
	assert.equal(fencedShard, 'wechat-shard-000');
	await state.close();
	await rm(dataDir, { recursive: true, force: true });
});

test('groups are discovered but ignored until allowlisted and mentioned', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	await state.initialize();
	let calls = 0;
	const gateway = new RyanAiGateway(
		config,
		state,
		{
			async send() {
				calls += 1;
				return { text: 'group reply' };
			}
		},
		quietLogger()
	);
	const groupBase = {
		channel: 'qq' as const,
		connectionId: 'qq-default',
		conversation: { type: 'group' as const, id: 'group-1', name: 'Lab' },
		sender: { id: 'member-1' }
	};
	await gateway.handle(
		inboundEvent({ ...groupBase, eventId: 'group-1', message: { text: 'hi', mentionsBot: true } })
	);
	assert.equal(calls, 0);
	assert.equal((await state.listGroups())[0]?.enabled, false);
	await state.patchGroup('qq', 'qq-default', 'group-1', { enabled: true });
	await gateway.handle(
		inboundEvent({ ...groupBase, eventId: 'group-2', message: { text: 'hi', mentionsBot: false } })
	);
	assert.equal(calls, 0);
	await gateway.handle(
		inboundEvent({ ...groupBase, eventId: 'group-3', message: { text: 'hi', mentionsBot: true } })
	);
	assert.equal(calls, 1);
});
