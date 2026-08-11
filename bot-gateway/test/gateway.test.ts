import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { chunkText } from '../src/chunk.js';
import { RyanAiGateway } from '../src/gateway.js';
import { RyanAiTransportError, type RyanAiTransport } from '../src/ryanai-client.js';
import { GatewayStateStore } from '../src/state.js';
import { inboundEvent, quietLogger, tempDataDir, testConfig } from './helpers.js';

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
	assert.equal(state.listGroups()[0]?.enabled, false);
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
