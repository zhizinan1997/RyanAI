import type { GatewayConfig } from '../config.js';
import { buildEventMultipart } from '../ryanai-client.js';
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
					accept: 'application/json'
				},
				body: Uint8Array.from(multipart.body),
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`bridge_http_${response.status}`);
		}
		const contentLength = Number(response.headers.get('content-length') || '0');
		if (contentLength > 1_048_576) throw new Error('bridge_response_too_large');
		const raw = await response.text();
		if (Buffer.byteLength(raw, 'utf8') > 1_048_576) {
			throw new Error('bridge_response_too_large');
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
