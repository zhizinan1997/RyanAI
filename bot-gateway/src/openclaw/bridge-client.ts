import type { GatewayConfig } from '../config.js';
import { buildEventMultipart, readResponseTextLimited } from '../ryanai-client.js';
import { signRequest } from '../security/hmac.js';
import type { GatewayInboundEvent, GatewayReply } from '../types.js';

interface BridgeResponse {
	version: '1.0';
	reply: GatewayReply;
}

export class OpenClawBridgeClient {
	constructor(
		private readonly config: GatewayConfig,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	async forward(event: GatewayInboundEvent): Promise<GatewayReply> {
		const multipart = buildEventMultipart(event);
		const signed = signRequest(this.config.hmacSecret, {
			method: 'POST',
			pathWithQuery: this.config.bridgePath,
			body: multipart.body
		});
		const endpoint = new URL(
			`http://127.0.0.1:${this.config.internalPort}${this.config.bridgePath}`
		);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.min(this.config.requestTimeoutMs + 10_000, 610_000)
		);
		timer.unref();

		let response: Response;
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers: {
					...signed,
					'content-type': multipart.contentType,
					'x-ryanai-event-id': event.eventId,
					// Names the shard-scoped key the control server must verify with; a
					// forged value fails verification because the body is signed with
					// this shard's own derived secret.
					...(this.config.openClawShardId
						? { 'x-ryanai-shard-id': this.config.openClawShardId }
						: {}),
					...(this.config.openClawNodeId
						? { 'x-ryanai-node-id': this.config.openClawNodeId }
						: {}),
					...(this.config.openClawLeaseEpoch !== undefined
						? { 'x-ryanai-lease-epoch': String(this.config.openClawLeaseEpoch) }
						: {}),
					...(this.config.openClawAssignmentGeneration !== undefined
						? {
								'x-ryanai-assignment-generation': String(
									this.config.openClawAssignmentGeneration
								)
							}
						: {}),
					accept: 'application/json'
				},
				body: Uint8Array.from(multipart.body),
				signal: controller.signal
			});
		} catch (error) {
			clearTimeout(timer);
			throw error;
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			clearTimeout(timer);
			throw new Error(`bridge_http_${response.status}`);
		}
		const contentLength = Number(response.headers.get('content-length') || '0');
		if (contentLength > 1_048_576) {
			clearTimeout(timer);
			throw new Error('bridge_response_too_large');
		}
		let raw: string;
		try {
			raw = await readResponseTextLimited(response, 1_048_576);
		} finally {
			clearTimeout(timer);
		}
		const parsed = JSON.parse(raw) as BridgeResponse;
		if (
			parsed.version !== '1.0' ||
			!parsed.reply ||
			parsed.reply.handled !== true ||
			parsed.reply.eventId !== event.eventId
		) {
			throw new Error('invalid_bridge_response');
		}
		return parsed.reply;
	}
}
