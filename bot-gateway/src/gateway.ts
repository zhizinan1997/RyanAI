import { chunkText } from './chunk.js';
import { validateEvent } from './event.js';
import { Logger, safeErrorFields } from './logger.js';
import { GatewayMetrics } from './metrics.js';
import { FairConnectionQueue, KeyedSerialQueue, QueueAdmissionError } from './queue.js';
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

interface ConnectionLoadState {
	updatedAt: number;
	events5m: number;
	events30m: number;
	processing5m: number;
	processing30m: number;
	attachment5m: number;
	attachment30m: number;
	errorTimes: number[];
}

export interface ConnectionLoadSnapshot {
	event_rate_5m: number;
	event_rate_30m: number;
	processing_seconds_per_minute: number;
	processing_seconds_per_minute_30m: number;
	attachment_mib_per_minute: number;
	attachment_mib_per_minute_30m: number;
	account_errors_10m: number;
	account_error_streak: number;
}

export class RyanAiGateway {
	private readonly serialQueue: KeyedSerialQueue;
	private readonly fairQueue: FairConnectionQueue;
	private readonly inFlightEvents = new Map<string, Promise<GatewayReply>>();
	private readonly connectionLoads = new Map<string, ConnectionLoadState>();
	private staleFenceHandler?: (shardId: string) => Promise<void>;

	constructor(
		private readonly config: GatewayConfig,
		private readonly state: GatewayStateStore,
		private readonly transport: RyanAiTransport,
		private readonly logger: Logger,
		readonly metrics = new GatewayMetrics()
	) {
		// A slow model turn must not pin every later message in the same
		// conversation: past this bound the queued event fails fast and safely
		// instead of holding the channel's delivery slot open indefinitely.
		this.serialQueue = new KeyedSerialQueue(100, config.maxQueueWaitMs);
		this.fairQueue = new FairConnectionQueue({
			maxGlobalActive: config.maxGlobalActiveEvents,
			maxConnectionActive: config.maxConnectionActiveEvents,
			maxGlobalQueued: config.maxGlobalQueuedEvents,
			maxConnectionQueued: config.maxConnectionQueuedEvents,
			maxQueuedBytes: config.maxQueuedPayloadBytes,
			maxWaitMs: config.maxQueueWaitMs
		});
	}

	onStaleFence(handler: (shardId: string) => Promise<void>): void {
		this.staleFenceHandler = handler;
	}

	queueSnapshot(): Record<string, number | boolean> {
		const snapshot = this.fairQueue.snapshot();
		return {
			accepting: snapshot.accepting,
			active: snapshot.active,
			queued: snapshot.queued,
			queuedBytes: snapshot.queuedBytes
		};
	}

	loadSnapshot(now = Date.now()): Record<string, ConnectionLoadSnapshot> {
		const result: Record<string, ConnectionLoadSnapshot> = {};
		for (const [connectionId, state] of this.connectionLoads) {
			this.decayLoad(state, now);
			state.errorTimes = state.errorTimes.filter((timestamp) => timestamp > now - 10 * 60_000);
			result[connectionId] = {
				event_rate_5m: state.events5m / 5,
				event_rate_30m: state.events30m / 30,
				processing_seconds_per_minute: state.processing5m / 5,
				processing_seconds_per_minute_30m: state.processing30m / 30,
				attachment_mib_per_minute: state.attachment5m / 5,
				attachment_mib_per_minute_30m: state.attachment30m / 30,
				account_errors_10m: state.errorTimes.length,
				account_error_streak: 0
			};
		}
		return result;
	}

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
		const startedAt = Date.now();
		let loadEvent: GatewayInboundEvent | undefined;
		let accountError = false;
		this.metrics.inc('bot_gateway_events_received_total', {
			channel: input.channel || 'unknown',
			connection_id: input.connectionId || 'unknown'
		});
		try {
			const event = validateEvent(input, this.config);
			const replayKey = eventKey(event);
			const claim = await this.state.claimEvent(replayKey);
			if (claim.status === 'completed') {
				this.metrics.inc('bot_gateway_events_replayed_total', { connection_id: event.connectionId });
				return {
					handled: true,
					eventId: event.eventId,
					chunks: claim.reply.chunks,
					isError: claim.reply.isError,
					replayed: true,
					reason: 'replay'
				};
			}
			if (claim.status === 'processing') return this.safeError(event.eventId, event.channel, true);
			loadEvent = event;

			const queuedAt = Date.now();
			try {
				const reply = await this.fairQueue.run(
					event.connectionId,
					this.eventPayloadBytes(event),
					async () => {
						this.updateQueueMetrics();
						this.metrics.observe(
							'bot_gateway_event_queue_duration_seconds',
							(Date.now() - queuedAt) / 1_000,
							{ connection_id: event.connectionId }
						);
						return this.serialQueue.run(conversationKey(event), () =>
							this.handleClaimedSerial(event, replayKey)
						);
					}
				);
				this.metrics.inc('bot_gateway_events_completed_total', {
					connection_id: event.connectionId,
					reason: reply.reason
				});
				accountError = reply.isError;
				return reply;
			} catch (error) {
				if (!(error instanceof QueueAdmissionError)) throw error;
				const reply = this.safeError(event.eventId, event.channel, false);
				await this.state.completeEvent(replayKey, reply);
				this.metrics.inc('bot_gateway_events_rejected_total', {
					connection_id: event.connectionId,
					reason: error.code
				});
				accountError = true;
				return reply;
			} finally {
				this.updateQueueMetrics();
			}
		} catch (error) {
			this.logger.warn('Inbound event rejected safely', {
				event_id: input.eventId,
				channel: input.channel,
				...safeErrorFields(error)
			});
			return this.safeError(input.eventId || 'unknown', input.channel, false);
		} finally {
			if (loadEvent) {
				this.recordLoad(
					loadEvent,
					(Date.now() - startedAt) / 1_000,
					accountError
				);
			}
			this.metrics.observe(
				'bot_gateway_event_duration_seconds',
				(Date.now() - startedAt) / 1_000,
				{ connection_id: input.connectionId || 'unknown' }
			);
		}
	}

	private async handleClaimedSerial(event: GatewayInboundEvent, replayKey: string): Promise<GatewayReply> {
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

		if (event.conversation.type === 'group' && !event.message.mentionsBot) {
			const ignored = this.ignored(event.eventId);
			await this.state.completeEvent(replayKey, ignored);
			return ignored;
		}

		if (
			event.conversation.type === 'group' &&
			!(await this.state.getGroup(event.channel, event.connectionId, event.conversation.id))?.enabled
		) {
			const ignored = this.ignored(event.eventId);
			await this.state.completeEvent(replayKey, ignored);
			return ignored;
		}

		let reply: GatewayReply;
		let releaseClaim = false;
		try {
			const result = await this.transport.send(event);
			const messages = (result.messages?.length ? result.messages : [result.text]).filter(
				(message): message is string => typeof message === 'string' && message.length > 0
			);
			if (messages.length === 0) {
				reply = this.ignored(event.eventId);
			} else {
				reply = {
					handled: true,
					eventId: event.eventId,
					chunks: messages.flatMap((message) =>
						chunkText(message, this.config.replyChunkChars[event.channel])
					),
					isError: false,
					replayed: false,
					reason: 'ryanai'
				};
			}
		} catch (error) {
			if (
				error instanceof RyanAiTransportError &&
				error.code === 'stale_fence' &&
				event.shardId
			) {
				reply = this.ignored(event.eventId);
				await this.state.completeEvent(replayKey, reply);
				await this.staleFenceHandler?.(event.shardId).catch((fenceError) =>
					this.logger.error('Failed to fence stale OpenClaw shard', {
						shard_id: event.shardId,
						...safeErrorFields(fenceError)
					})
				);
				return reply;
			}
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

	async shutdown(graceMs = this.config.shutdownGraceMs): Promise<boolean> {
		this.fairQueue.stopAccepting();
		const drained = await this.fairQueue.waitForIdle(graceMs);
		if (!drained) this.fairQueue.cancelQueued();
		this.updateQueueMetrics();
		return drained;
	}

	private eventPayloadBytes(event: GatewayInboundEvent): number {
		return Buffer.byteLength(event.message.text, 'utf8') + event.attachments.reduce(
			(total, attachment) => total + attachment.bytes.length,
			0
		);
	}

	private recordLoad(
		event: GatewayInboundEvent,
		processingSeconds: number,
		accountError: boolean
	): void {
		const now = Date.now();
		const state = this.connectionLoads.get(event.connectionId) ?? {
			updatedAt: now,
			events5m: 0,
			events30m: 0,
			processing5m: 0,
			processing30m: 0,
			attachment5m: 0,
			attachment30m: 0,
			errorTimes: []
		};
		this.decayLoad(state, now);
		const attachmentMib = event.attachments.reduce(
			(total, attachment) => total + attachment.bytes.length,
			0
		) / (1024 * 1024);
		state.events5m += 1;
		state.events30m += 1;
		state.processing5m += processingSeconds;
		state.processing30m += processingSeconds;
		state.attachment5m += attachmentMib;
		state.attachment30m += attachmentMib;
		if (accountError) {
			state.errorTimes.push(now);
		}
		this.connectionLoads.set(event.connectionId, state);
	}

	private decayLoad(state: ConnectionLoadState, now: number): void {
		const elapsed = Math.max(0, now - state.updatedAt);
		if (elapsed === 0) return;
		const decay5m = Math.exp(-elapsed / (5 * 60_000));
		const decay30m = Math.exp(-elapsed / (30 * 60_000));
		state.events5m *= decay5m;
		state.processing5m *= decay5m;
		state.attachment5m *= decay5m;
		state.events30m *= decay30m;
		state.processing30m *= decay30m;
		state.attachment30m *= decay30m;
		state.updatedAt = now;
	}

	private updateQueueMetrics(): void {
		const snapshot = this.fairQueue.snapshot();
		this.metrics.set('bot_gateway_queue_depth', snapshot.queued);
		this.metrics.set('bot_gateway_queue_bytes', snapshot.queuedBytes);
		this.metrics.set('bot_gateway_events_active', snapshot.active);
		for (const [connectionId, active] of snapshot.activeByConnection) {
			this.metrics.set('bot_gateway_connection_events_active', active, {
				connection_id: connectionId
			});
		}
		for (const [connectionId, queued] of snapshot.queuedByConnection) {
			this.metrics.set('bot_gateway_connection_queue_depth', queued, {
				connection_id: connectionId
			});
		}
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
