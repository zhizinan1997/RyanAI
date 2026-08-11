import { chunkText } from './chunk.js';
import { validateEvent } from './event.js';
import { Logger, safeErrorFields } from './logger.js';
import { KeyedSerialQueue } from './queue.js';
import type { GatewayConfig } from './config.js';
import type { GatewayStateStore } from './state.js';
import type { GatewayInboundEvent, GatewayReply } from './types.js';
import { RyanAiTransportError, type RyanAiTransport } from './ryanai-client.js';

function conversationKey(event: GatewayInboundEvent): string {
	const senderScope = event.conversation.type === 'group' ? `:${event.sender.id}` : '';
	return `${event.channel}:${event.connectionId}:${event.conversation.type}:${event.conversation.id}${senderScope}`;
}

function eventKey(
	event: Pick<GatewayInboundEvent, 'channel' | 'connectionId' | 'eventId'>
): string {
	return `${event.channel}\u0000${event.connectionId}\u0000${event.eventId}`;
}

export class RyanAiGateway {
	private readonly serialQueue = new KeyedSerialQueue();
	private readonly inFlightEvents = new Map<string, Promise<GatewayReply>>();

	constructor(
		private readonly config: GatewayConfig,
		private readonly state: GatewayStateStore,
		private readonly transport: RyanAiTransport,
		private readonly logger: Logger
	) {}

	handle(input: GatewayInboundEvent): Promise<GatewayReply> {
		const replayKey = eventKey({
			channel: input.channel,
			connectionId: input.connectionId,
			eventId: typeof input.eventId === 'string' ? input.eventId : 'unknown'
		});
		const existing = this.inFlightEvents.get(replayKey);
		if (existing) return existing;

		const operation = this.handleSafely(input).finally(() => {
			if (this.inFlightEvents.get(replayKey) === operation) this.inFlightEvents.delete(replayKey);
		});
		this.inFlightEvents.set(replayKey, operation);
		return operation;
	}

	private async handleSafely(input: GatewayInboundEvent): Promise<GatewayReply> {
		try {
			const event = validateEvent(input, this.config);
			return await this.serialQueue.run(conversationKey(event), () => this.handleSerial(event));
		} catch (error) {
			this.logger.warn('Inbound event rejected safely', {
				event_id: input.eventId,
				channel: input.channel,
				...safeErrorFields(error)
			});
			return this.safeError(input.eventId || 'unknown', input.channel, false);
		}
	}

	private async handleSerial(event: GatewayInboundEvent): Promise<GatewayReply> {
		if (event.conversation.type === 'group') {
			await this.state.upsertGroup({
				channel: event.channel,
				connectionId: event.connectionId,
				groupId: event.conversation.id,
				enabled: false,
				...(event.conversation.name ? { name: event.conversation.name } : {}),
				lastSeenAt: new Date(event.occurredAt).toISOString()
			});
		}

		const replayKey = eventKey(event);
		const claim = await this.state.claimEvent(replayKey);
		if (claim.status === 'completed') {
			return {
				handled: true,
				eventId: event.eventId,
				chunks: claim.reply.chunks,
				isError: claim.reply.isError,
				replayed: true,
				reason: 'replay'
			};
		}
		if (claim.status === 'processing') {
			return this.safeError(event.eventId, event.channel, true);
		}

		if (event.conversation.type === 'group' && !event.message.mentionsBot) {
			const ignored = this.ignored(event.eventId);
			await this.state.completeEvent(replayKey, ignored);
			return ignored;
		}

		if (
			event.conversation.type === 'group' &&
			!this.state.getGroup(event.channel, event.connectionId, event.conversation.id)?.enabled
		) {
			const ignored = this.ignored(event.eventId);
			await this.state.completeEvent(replayKey, ignored);
			return ignored;
		}

		let reply: GatewayReply;
		let releaseClaim = false;
		try {
			const result = await this.transport.send(event);
			if (result.text === null || result.text === '') {
				reply = this.ignored(event.eventId);
			} else {
				reply = {
					handled: true,
					eventId: event.eventId,
					chunks: chunkText(result.text, this.config.replyChunkChars[event.channel]),
					isError: false,
					replayed: false,
					reason: 'ryanai'
				};
			}
		} catch (error) {
			this.logger.error('RyanAI event delivery failed closed', {
				event_id: event.eventId,
				channel: event.channel,
				...safeErrorFields(error)
			});
			reply = this.safeError(event.eventId, event.channel, false);
			releaseClaim = error instanceof RyanAiTransportError && error.retryable;
		}
		if (releaseClaim) await this.state.releaseEvent(replayKey);
		else await this.state.completeEvent(replayKey, reply);
		return reply;
	}

	private ignored(eventId: string): GatewayReply {
		return {
			handled: true,
			eventId,
			chunks: [],
			isError: false,
			replayed: false,
			reason: 'ignored'
		};
	}

	private safeError(
		eventId: string,
		channel: GatewayInboundEvent['channel'],
		replayed: boolean
	): GatewayReply {
		return {
			handled: true,
			eventId,
			chunks: chunkText(
				this.config.safeErrorMessage,
				this.config.replyChunkChars[channel] || 1_800
			),
			isError: true,
			replayed,
			reason: replayed ? 'replay' : 'safe-error'
		};
	}
}
