import assert from 'node:assert/strict';
import test from 'node:test';

import { registerRyanAiBridge } from '../src/openclaw/plugin.js';
import type { GatewayInboundEvent, GatewayReply } from '../src/types.js';
import { testConfig } from './helpers.js';

test('RyanAI bridge claims global reply_dispatch before any OpenClaw model hook', async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	let forwarded: GatewayInboundEvent | undefined;
	let queuedText = '';
	let modelHookCalled = false;
	const reply: GatewayReply = {
		handled: true,
		eventId: 'qq-message-reply-dispatch-1',
		chunks: ['RyanAI reply'],
		isError: false,
		replayed: false,
		reason: 'ryanai'
	};

	registerRyanAiBridge(
		{
			logger: {},
			on(name: string, handler: (...args: any[]) => Promise<unknown> | unknown): void {
				handlers.set(name, handler);
			}
		},
		async () => ({
			config: testConfig('unused'),
			client: {
				async forward(event: GatewayInboundEvent): Promise<GatewayReply> {
					forwarded = event;
					return reply;
				}
			}
		})
	);

	const result = await handlers.get('reply_dispatch')?.(
		{
			ctx: {
				Provider: 'qqbot',
				Surface: 'qqbot',
				AccountId: 'default',
				ChatType: 'group',
				QQGroupOpenid: 'group-openid-42',
				SenderId: 'member-openid-7',
				RawBody: 'hello',
				MessageSid: 'qq-message-reply-dispatch-1',
				Timestamp: Date.now()
			},
			sendPolicy: 'allow',
			suppressUserDelivery: false
		},
		{
			dispatcher: {
				sendFinalReply(payload: { text?: string }): boolean {
					queuedText = payload.text || '';
					return true;
				},
				markComplete(): void {},
				getQueuedCounts(): { tool: number; block: number; final: number } {
					return { tool: 0, block: 0, final: 1 };
				}
			},
			recordProcessed(): void {},
			markIdle(): void {}
		}
	);

	assert.deepEqual(result, {
		handled: true,
		queuedFinal: true,
		counts: { tool: 0, block: 0, final: 1 }
	});
	assert.equal(forwarded?.connectionId, 'qq-default');
	assert.equal(forwarded?.conversation.type, 'group');
	assert.equal(forwarded?.message.mentionsBot, true);
	assert.equal(queuedText, 'RyanAI reply');
	assert.equal(handlers.has('before_dispatch'), false);
	const modelHandler = handlers.get('model_call_started');
	modelHandler?.({}, {});
	modelHookCalled = handlers.has('model_call_started') && modelHookCalled;
	assert.equal(modelHookCalled, false);
});
