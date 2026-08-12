import { sha256Hex, signRequest } from './security/hmac.js';
import { buildMultipartBody, type MultipartBody } from './multipart.js';
import type { GatewayConfig } from './config.js';
import type { GatewayInboundEvent, RyanAiWireEvent } from './types.js';

export interface RyanAiResult {
	text: string | null;
	messages?: string[];
}

export interface RyanAiTransport {
	send(event: GatewayInboundEvent): Promise<RyanAiResult>;
}

export class RyanAiTransportError extends Error {
	readonly retryable: boolean;

	constructor(readonly code: string, cause?: unknown) {
		super(code, cause === undefined ? undefined : { cause });
		this.name = 'RyanAiTransportError';
		const status = /^http_(\d{3})$/.exec(code)?.[1];
		const statusCode = status ? Number(status) : undefined;
		this.retryable =
			code === 'timeout' ||
			code === 'network_error' ||
			statusCode === 408 ||
			statusCode === 425 ||
			statusCode === 429 ||
			(statusCode !== undefined && statusCode >= 500);
	}
}

interface RyanAiResponse {
	version: '1.0';
	event_id: string;
	status: 'ok' | 'ignored';
	reply?: {
		text: string;
		messages?: string[];
	} | null;
}

function optionalName(value: string | undefined): { name?: string } {
	return value ? { name: value } : {};
}

export function buildWireEvent(event: GatewayInboundEvent): RyanAiWireEvent {
	return {
		version: '1.0',
		event_id: event.eventId,
		// Shard routing metadata rides only on the shard→gateway bridge leg; the
		// control server strips it after resolving the owning connection, so the
		// backend (extra='forbid') never sees these fields.
		...(event.accountKey ? { account_id: event.accountKey } : {}),
		...(event.shardId ? { shard_id: event.shardId } : {}),
		occurred_at: new Date(event.occurredAt).toISOString(),
		channel: event.channel,
		connection_id: event.connectionId,
		conversation: {
			type: event.conversation.type,
			id: event.conversation.id,
			...optionalName(event.conversation.name)
		},
		sender: {
			id: event.sender.id,
			...optionalName(event.sender.name)
		},
		message: {
			text: event.message.text,
			mentions_bot: event.message.mentionsBot
		},
		attachments: event.attachments.map((attachment, index) => ({
			field_name: `attachment_${index}`,
			id: attachment.id,
			file_name: attachment.fileName,
			content_type: attachment.contentType,
			size: attachment.bytes.length,
			sha256: sha256Hex(attachment.bytes)
		}))
	};
}

export function buildEventMultipart(event: GatewayInboundEvent): MultipartBody {
	return buildMultipartBody(
		JSON.stringify(buildWireEvent(event)),
		event.attachments.map((attachment, index) => ({
			fieldName: `attachment_${index}`,
			fileName: attachment.fileName,
			contentType: attachment.contentType,
			bytes: attachment.bytes
		}))
	);
}

export async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let result = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel('response_too_large').catch(() => undefined);
				throw new RyanAiTransportError('response_too_large');
			}
			result += decoder.decode(value, { stream: true });
		}
		return result + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

export class RyanAiClient implements RyanAiTransport {
	constructor(
		private readonly config: GatewayConfig,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	async send(event: GatewayInboundEvent): Promise<RyanAiResult> {
		const multipart = buildEventMultipart(event);
		const signed = signRequest(this.config.hmacSecret, {
			method: 'POST',
			pathWithQuery: this.config.eventPath,
			body: multipart.body
		});
		const endpoint = new URL(this.config.eventPath, this.config.ryanAiBaseUrl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
		timer.unref();

		let response: Response;
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers: {
					...signed,
					'content-type': multipart.contentType,
					'idempotency-key': event.eventId,
					'x-ryanai-event-id': event.eventId,
					accept: 'application/json'
				},
				body: Uint8Array.from(multipart.body),
				signal: controller.signal
			});
		} catch (error) {
			clearTimeout(timer);
			if (controller.signal.aborted) throw new RyanAiTransportError('timeout');
			throw new RyanAiTransportError('network_error', error);
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			clearTimeout(timer);
			throw new RyanAiTransportError(`http_${response.status}`);
		}

		const contentLength = Number(response.headers.get('content-length') || '0');
		if (contentLength > 1_048_576) {
			clearTimeout(timer);
			throw new RyanAiTransportError('response_too_large');
		}
		let responseText: string;
		try {
			responseText = await readResponseTextLimited(response, 1_048_576);
		} catch (error) {
			if (error instanceof RyanAiTransportError) throw error;
			if (controller.signal.aborted) throw new RyanAiTransportError('timeout');
			throw new RyanAiTransportError('network_error', error);
		} finally {
			clearTimeout(timer);
		}
		let parsed: RyanAiResponse;
		try {
			parsed = JSON.parse(responseText) as RyanAiResponse;
		} catch {
			throw new RyanAiTransportError('invalid_json');
		}
		if (
			parsed.version !== '1.0' ||
			parsed.event_id !== event.eventId ||
			(parsed.status !== 'ok' && parsed.status !== 'ignored')
		) {
			throw new RyanAiTransportError('invalid_response');
		}
		if (parsed.status === 'ignored') return { text: null };
		if (!parsed.reply || typeof parsed.reply.text !== 'string') {
			throw new RyanAiTransportError('missing_reply');
		}
		if (Array.from(parsed.reply.text).length > this.config.maxResponseTextChars) {
			throw new RyanAiTransportError('reply_too_large');
		}
		if (parsed.reply.messages !== undefined) {
			if (
				!Array.isArray(parsed.reply.messages) ||
				parsed.reply.messages.length === 0 ||
				parsed.reply.messages.length > 20 ||
				parsed.reply.messages.some(
					(message) => typeof message !== 'string' || message.length === 0
				)
			) {
				throw new RyanAiTransportError('invalid_reply_messages');
			}
			const totalMessageChars = parsed.reply.messages.reduce(
				(total, message) => total + Array.from(message).length,
				0
			);
			if (totalMessageChars > this.config.maxResponseTextChars) {
				throw new RyanAiTransportError('reply_too_large');
			}
			return { text: parsed.reply.text, messages: parsed.reply.messages };
		}
		return { text: parsed.reply.text };
	}
}
