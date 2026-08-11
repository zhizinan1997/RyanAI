import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type {
	PluginHookInboundClaimContext,
	PluginHookInboundClaimEvent
} from 'openclaw/plugin-sdk/plugin-entry';

import { loadConfig, type GatewayConfig } from '../config.js';
import { safeErrorFields } from '../logger.js';
import type { GatewayReply } from '../types.js';
import { OpenClawBridgeClient } from './bridge-client.js';
import {
	normalizeInboundClaim,
	normalizeReplyDispatch,
	type FinalizedMessageContextLike,
	type ReplyDispatchHookLike
} from './normalize.js';

interface PluginRuntime {
	client: { forward(event: Parameters<OpenClawBridgeClient['forward']>[0]): Promise<GatewayReply> };
	config: GatewayConfig;
}

interface ReplyPayloadLike {
	text?: string;
	isError?: boolean;
	channelData?: Record<string, unknown>;
}

interface AgentContextLike {
	runId?: string;
}

interface ReplyDispatcherLike {
	sendFinalReply(payload: ReplyPayloadLike): boolean;
	markComplete(): void;
	getQueuedCounts(): Record<'tool' | 'block' | 'final', number>;
}

interface ReplyDispatchEventLike extends ReplyDispatchHookLike {
	sendPolicy?: 'allow' | 'deny';
	suppressUserDelivery?: boolean;
}

interface ReplyDispatchContextLike {
	dispatcher: ReplyDispatcherLike;
	recordProcessed(outcome: 'completed' | 'skipped' | 'error', options?: { reason?: string }): void;
	markIdle(reason: string): void;
}

interface OpenClawPluginApiLike {
	logger: {
		warn?: (message: string) => void;
		error?: (message: string) => void;
	};
	on(
		name: 'inbound_claim',
		handler: (
			event: PluginHookInboundClaimEvent,
			ctx: PluginHookInboundClaimContext
		) => Promise<{ handled: boolean; reply?: ReplyPayloadLike }>,
		options?: { priority?: number; timeoutMs?: number }
	): void;
	on(
		name: 'reply_dispatch',
		handler: (
			event: ReplyDispatchEventLike,
			ctx: ReplyDispatchContextLike
		) => Promise<{
			handled: boolean;
			queuedFinal: boolean;
			counts: Record<'tool' | 'block' | 'final', number>;
		}>,
		options?: { priority?: number; timeoutMs?: number }
	): void;
	on(
		name: 'before_agent_reply',
		handler: () => Promise<{
			handled: boolean;
			reply?: ReplyPayloadLike;
			reason?: string;
		}>,
		options?: { priority?: number; timeoutMs?: number }
	): void;
	on(
		name: 'model_call_started',
		handler: (event: unknown, ctx: AgentContextLike) => void,
		options?: { priority?: number; timeoutMs?: number }
	): void;
}

type RuntimeFactory = () => Promise<PluginRuntime>;

async function buildRuntime(): Promise<PluginRuntime> {
	const config = loadConfig(process.env, { requireCredentialsEncryptionKey: false });
	return {
		client: new OpenClawBridgeClient(config),
		config
	};
}

function fallbackErrorMessage(): string {
	return (
		process.env.BOT_GATEWAY_SAFE_ERROR_MESSAGE?.trim() ||
		'RyanAI is temporarily unable to process this message. Please try again later.'
	);
}

function replyPayload(reply: GatewayReply): ReplyPayloadLike | undefined {
	if (reply.chunks.length === 0) return undefined;
	return {
		text: reply.chunks.join(''),
		isError: reply.isError,
		channelData: {
			ryanai: {
				event_id: reply.eventId,
				replayed: reply.replayed
			}
		}
	};
}

function emptyCounts(): Record<'tool' | 'block' | 'final', number> {
	return { tool: 0, block: 0, final: 0 };
}

async function handleReplyDispatch(
	event: ReplyDispatchEventLike,
	context: ReplyDispatchContextLike,
	runtime: Promise<PluginRuntime>,
	logger: OpenClawPluginApiLike['logger']
): Promise<{
	handled: boolean;
	queuedFinal: boolean;
	counts: Record<'tool' | 'block' | 'final', number>;
}> {
	let replyText = fallbackErrorMessage();
	let isError = true;
	let errorPhase = 'runtime';
	try {
		const active = await runtime;
		errorPhase = 'normalize';
		const inbound = await normalizeReplyDispatch(
			event as ReplyDispatchHookLike & { ctx: FinalizedMessageContextLike },
			active.config
		);
		errorPhase = 'forward';
		const reply = await active.client.forward(inbound);
		replyText = reply.chunks.join('');
		isError = reply.isError;
	} catch (error) {
		logger.error?.(
			`RyanAI reply bridge failed closed: ${JSON.stringify({ phase: errorPhase, ...safeErrorFields(error) })}`
		);
	}

	let queuedFinal = false;
	try {
		if (replyText && event.sendPolicy !== 'deny' && event.suppressUserDelivery !== true) {
			queuedFinal = context.dispatcher.sendFinalReply({ text: replyText, isError });
		}
	} catch (error) {
		logger.error?.(
			`RyanAI reply delivery failed closed: ${JSON.stringify(safeErrorFields(error))}`
		);
	} finally {
		try {
			context.dispatcher.markComplete();
		} catch (error) {
			logger.error?.(
				`RyanAI dispatcher completion failed: ${JSON.stringify(safeErrorFields(error))}`
			);
		}
		context.recordProcessed('completed', { reason: 'ryanai-bridge-reply-dispatch' });
		context.markIdle('ryanai-bridge-reply-dispatch');
	}

	let counts = emptyCounts();
	try {
		counts = context.dispatcher.getQueuedCounts();
	} catch (error) {
		logger.error?.(`RyanAI dispatcher count failed: ${JSON.stringify(safeErrorFields(error))}`);
	}
	return { handled: true, queuedFinal, counts };
}

export function registerRyanAiBridge(
	api: OpenClawPluginApiLike,
	runtimeFactory: RuntimeFactory = buildRuntime
): void {
	// Keep configuration loading lazy. A malformed child environment must still
	// produce a handled safe error instead of an unhandled rejected promise at
	// plugin registration time.
	let runtime: Promise<PluginRuntime> | undefined;
	const getRuntime = (): Promise<PluginRuntime> => (runtime ??= runtimeFactory());

	// This hook remains useful for conversations explicitly bound to a plugin.
	// Ordinary channel messages use the global reply_dispatch hook below.
	api.on(
		'inbound_claim',
		async (event, ctx) => {
			try {
				const active = await getRuntime();
				const inbound = await normalizeInboundClaim(event, ctx, active.config);
				const reply = await active.client.forward(inbound);
				const payload = replyPayload(reply);
				return { handled: true, ...(payload ? { reply: payload } : {}) };
			} catch (error) {
				api.logger.error?.(
					`RyanAI inbound bridge failed closed: ${JSON.stringify(safeErrorFields(error))}`
				);
				return {
					handled: true,
					reply: { text: fallbackErrorMessage(), isError: true }
				};
			}
		},
		{ priority: 1_000_000, timeoutMs: 610_000 }
	);

	// OpenClaw 2026.7.1-2 invokes reply_dispatch for ordinary unbound channel
	// messages before model resolution. This is the primary global gate: every
	// path is handled here and therefore no OpenClaw Agent/model is entered.
	api.on(
		'reply_dispatch',
		(event, context) => handleReplyDispatch(event, context, getRuntime(), api.logger),
		{ priority: 1_000_000, timeoutMs: 610_000 }
	);

	// Defense in depth for a future channel path that bypasses both global
	// dispatch and the typed claim hook.
	api.on(
		'before_agent_reply',
		async () => ({
			handled: true,
			reply: { text: fallbackErrorMessage(), isError: true },
			reason: 'ryanai-bridge-unclaimed-inbound'
		}),
		{ priority: 1_000_000, timeoutMs: 610_000 }
	);

	api.on('model_call_started', (_event, ctx) => {
		api.logger.error?.(
			`SECURITY INVARIANT VIOLATION: OpenClaw model call started (${String(ctx.runId || 'unknown')})`
		);
	});
}

export default definePluginEntry({
	id: 'ryanai-bridge',
	name: 'RyanAI Bridge',
	description: 'Fail-closed WeChat/QQ message bridge for RyanAI',
	register: registerRyanAiBridge
});
