import assert from 'node:assert/strict';
import test from 'node:test';

import { registerRyanAiBridge } from '../src/openclaw/plugin.js';
import type { GatewayInboundEvent, GatewayReply } from '../src/types.js';
import { testConfig } from './helpers.js';

test('RyanAI bridge claims global reply_dispatch before any OpenClaw model hook', async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	let forwarded: GatewayInboundEvent | undefined;
	const queuedTexts: string[] = [];
	const loggedErrors: string[] = [];
	const reply: GatewayReply = {
		handled: true,
		eventId: 'qq-message-reply-dispatch-1',
		chunks: ['Privacy notice', 'Usage tutorial'],
		isError: false,
		replayed: false,
		reason: 'ryanai'
	};

	registerRyanAiBridge(
		{
			logger: {
				error(line: string): void {
					loggedErrors.push(line);
				}
			},
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
					queuedTexts.push(payload.text || '');
					return true;
				},
				markComplete(): void {},
				getQueuedCounts(): { tool: number; block: number; final: number } {
					return { tool: 0, block: 0, final: 2 };
				}
			},
			recordProcessed(): void {},
			markIdle(): void {}
		}
	);

	assert.deepEqual(result, {
		handled: true,
		queuedFinal: true,
		counts: { tool: 0, block: 0, final: 2 }
	});
	assert.equal(forwarded?.connectionId, 'qq-default');
	assert.equal(forwarded?.conversation.type, 'group');
	assert.equal(forwarded?.message.mentionsBot, true);
	assert.deepEqual(queuedTexts, ['Privacy notice', 'Usage tutorial']);
	assert.equal(handlers.has('before_dispatch'), false);
	// `model_call_started` exists only as a tripwire: OpenClaw must never run
	// inference for a bridged message, so firing it has to surface loudly instead
	// of passing silently.
	const modelHandler = handlers.get('model_call_started');
	assert.equal(typeof modelHandler, 'function');
	modelHandler?.({}, { runId: 'run-42' });
	assert.equal(loggedErrors.length, 1);
	assert.match(String(loggedErrors[0]), /SECURITY INVARIANT VIOLATION.*run-42/);
});

test('RyanAI bridge sends signed bot media links as structured attachments', async () => {
	const handlers = new Map<string, (...args: any[]) => Promise<unknown> | unknown>();
	const queuedPayloads: Array<{ text?: string; mediaUrl?: string; isError?: boolean }> = [];
	const mediaUrl =
		'https://chat.zhizinan.top/api/v1/internal/bot-gateway/media/signed-media-token';

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
				async forward(): Promise<GatewayReply> {
					return {
						handled: true,
						eventId: 'wechat-generated-image-1',
						chunks: ['Here is the generated image.', mediaUrl],
						isError: false,
						replayed: false,
						reason: 'ryanai'
					};
				}
			}
		})
	);

	await handlers.get('reply_dispatch')?.(
		{
			ctx: {
				Provider: 'qqbot',
				Surface: 'qqbot',
				AccountId: 'default',
				ChatType: 'private',
				SenderId: 'wechat-user',
				RawBody: 'generate an image',
				MessageSid: 'wechat-generated-image-1',
				Timestamp: Date.now()
			},
			sendPolicy: 'allow',
			suppressUserDelivery: false
		},
		{
			dispatcher: {
				sendFinalReply(payload: {
					text?: string;
					mediaUrl?: string;
					isError?: boolean;
				}): boolean {
					queuedPayloads.push(payload);
					return true;
				},
				markComplete(): void {},
				getQueuedCounts(): { tool: number; block: number; final: number } {
					return { tool: 0, block: 0, final: 2 };
				}
			},
			recordProcessed(): void {},
			markIdle(): void {}
		}
	);

	assert.deepEqual(queuedPayloads, [
		{ text: 'Here is the generated image.', isError: false },
		{ mediaUrl, isError: false }
	]);
});
