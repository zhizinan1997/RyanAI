import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ChannelAdapter, MockInjectableAdapter } from './adapters/types.js';
import { AdapterError } from './adapters/types.js';
import type { GatewayConfig } from './config.js';
import { EventValidationError } from './event.js';
import type { RyanAiGateway } from './gateway.js';
import { Logger, safeErrorFields } from './logger.js';
import { parseOpenClawBridgeEvent } from './openclaw/bridge-server.js';
import { NonceReplayCache, verifyRequest } from './security/hmac.js';
import type { CredentialVault } from './security/vault.js';
import type { GatewayStateStore } from './state.js';

class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string
	) {
		super(code);
		this.name = 'HttpError';
	}
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const contentLength = Number(headerValue(request, 'content-length') || '0');
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new HttpError(413, 'request_too_large');
	}
	if (headerValue(request, 'content-encoding')) {
		throw new HttpError(415, 'content_encoding_not_supported');
	}

	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > maxBytes) throw new HttpError(413, 'request_too_large');
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

function parseJson(body: Buffer): Record<string, unknown> {
	if (body.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString('utf8'));
	} catch {
		throw new HttpError(400, 'invalid_json');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new HttpError(400, 'json_object_required');
	}
	return parsed as Record<string, unknown>;
}

function decodeSegment(value: string): string {
	try {
		const decoded = decodeURIComponent(value);
		if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
			throw new Error('invalid segment');
		}
		return decoded;
	} catch {
		throw new HttpError(400, 'invalid_path_parameter');
	}
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: unknown,
	requestId: string
): void {
	const body = statusCode === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8');
	response.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': body.length,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'",
		'x-request-id': requestId
	});
	response.end(body);
}

export class ControlServer {
	private server: Server | undefined;
	private readonly nonces: NonceReplayCache;

	constructor(
		private readonly config: GatewayConfig,
		private readonly adapter: ChannelAdapter,
		private readonly state: GatewayStateStore,
		private readonly vault: CredentialVault,
		private readonly gateway: RyanAiGateway,
		private readonly logger: Logger
	) {
		this.nonces = new NonceReplayCache(config.signatureMaxSkewSeconds * 2_000);
	}

	async start(): Promise<number> {
		if (this.server) throw new Error('Control server is already started');
		this.server = createServer((request, response) => {
			void this.handle(request, response);
		});
		this.server.requestTimeout = Math.max(this.config.requestTimeoutMs + 15_000, 30_000);
		this.server.headersTimeout = 10_000;
		this.server.keepAliveTimeout = 5_000;
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(this.config.internalPort, this.config.host, () => {
				this.server!.off('error', reject);
				resolve();
			});
		});
		const address = this.server.address();
		return typeof address === 'object' && address ? address.port : this.config.internalPort;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const startedAt = Date.now();
		const requestId = randomUUID();
		const method = request.method || 'GET';
		const pathWithQuery = request.url || '/';
		let statusCode = 500;

		try {
			if (method === 'GET' && pathWithQuery === '/health') {
				const health = this.adapter.health();
				statusCode = health.ready ? 200 : 503;
				sendJson(
					response,
					statusCode,
					{
						version: '1.0',
						status: health.ready ? 'ok' : 'degraded',
						adapter: health,
						enabled_channels: [...this.config.enabledChannels]
					},
					requestId
				);
				return;
			}

			const body = await readBody(request, this.config.maxControlBodyBytes);
			this.authenticate(request, method, pathWithQuery, body);
			const url = new URL(pathWithQuery, 'http://bot-gateway.internal');
			statusCode = await this.route(
				method,
				url,
				body,
				response,
				requestId,
				headerValue(request, 'content-type'),
				headerValue(request, 'x-ryanai-event-id')
			);
		} catch (error) {
			const mapped = this.mapError(error);
			statusCode = mapped.statusCode;
			if (!response.headersSent) {
				sendJson(
					response,
					mapped.statusCode,
					{ version: '1.0', error: { code: mapped.code }, request_id: requestId },
					requestId
				);
			} else {
				response.destroy();
			}
			if (mapped.statusCode >= 500) {
				this.logger.error('Control request failed', {
					request_id: requestId,
					method,
					path: pathWithQuery.split('?', 1)[0],
					...safeErrorFields(error)
				});
			}
		} finally {
			this.logger.info('Control request completed', {
				request_id: requestId,
				method,
				path: pathWithQuery.split('?', 1)[0],
				status_code: statusCode,
				duration_ms: Date.now() - startedAt
			});
		}
	}

	private authenticate(
		request: IncomingMessage,
		method: string,
		pathWithQuery: string,
		body: Buffer
	): void {
		const verification = verifyRequest({
			secret:
				pathWithQuery.split('?', 1)[0] === this.config.bridgePath
					? this.config.bridgeHmacSecret
					: this.config.hmacSecret,
			method,
			pathWithQuery,
			body,
			timestamp: headerValue(request, 'x-ryanai-timestamp'),
			nonce: headerValue(request, 'x-ryanai-nonce'),
			contentSha256: headerValue(request, 'x-ryanai-content-sha256'),
			signature: headerValue(request, 'x-ryanai-signature'),
			maxSkewSeconds: this.config.signatureMaxSkewSeconds
		});
		if (!verification.ok) throw new HttpError(401, verification.reason);
		if (!this.nonces.claim(verification.nonce)) throw new HttpError(409, 'replayed_nonce');
	}

	private async route(
		method: string,
		url: URL,
		body: Buffer,
		response: ServerResponse,
		requestId: string,
		contentType?: string,
		eventIdHeader?: string
	): Promise<number> {
		if (method === 'GET' && url.pathname === '/v1/connections') {
			const ownerUserId = url.searchParams.get('owner_user_id') || url.searchParams.get('user_id') || undefined;
			const channel = url.searchParams.get('channel') || undefined;
			const connections = (await this.adapter.listConnections()).filter((entry) =>
				(!ownerUserId || entry.ownerUserId === ownerUserId) && (!channel || entry.channel === channel)
			);
			sendJson(
				response,
				200,
				{ version: '1.0', connections },
				requestId
			);
			return 200;
		}

		if (method === 'POST' && url.pathname === '/v1/connections') {
			const input = parseJson(body);
			if (input.channel !== 'wechat' && input.channel !== 'qq') throw new HttpError(400, 'channel_required');
			const ownerUserId = typeof input.owner_user_id === 'string' ? input.owner_user_id : typeof input.user_id === 'string' ? input.user_id : '';
			if (!ownerUserId.trim()) throw new HttpError(400, 'owner_user_id_required');
			const connection = await this.adapter.createConnection({
				channel: input.channel,
				ownerUserId,
				...(typeof input.connection_id === 'string' ? { id: input.connection_id } : {}),
				...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
				...(typeof input.account_label === 'string' ? { accountLabel: input.account_label } : {})
			});
			sendJson(response, 201, { version: '1.0', connection }, requestId);
			return 201;
		}

		if (method === 'POST' && url.pathname === this.config.bridgePath) {
			if (this.adapter.mode !== 'openclaw') throw new HttpError(404, 'not_found');
			const event = await parseOpenClawBridgeEvent(body, contentType, this.config);
			if (eventIdHeader && eventIdHeader !== event.eventId) {
				throw new HttpError(400, 'event_id_mismatch');
			}
			const connection = this.state.getConnection(event.connectionId);
			const reply =
				!connection || !connection.enabled
					? {
							handled: true as const,
							eventId: event.eventId,
							chunks: [],
							isError: false,
							replayed: false,
							reason: 'ignored' as const
						}
					: await this.gateway.handle(event);
			sendJson(response, 200, { version: '1.0', reply }, requestId);
			return 200;
		}

		if (method === 'POST' && url.pathname === '/v1/mock/events') {
			if (this.adapter.mode !== 'mock' || !('inject' in this.adapter)) {
				throw new HttpError(404, 'not_found');
			}
			const reply = await (this.adapter as MockInjectableAdapter).inject(parseJson(body) as never);
			sendJson(response, 200, { version: '1.0', reply }, requestId);
			return 200;
		}

		const match = url.pathname.match(/^\/v1\/connections\/([^/]+)(?:\/(.*))?$/);
		if (!match) throw new HttpError(404, 'not_found');
		const connectionId = decodeSegment(match[1]!);
		const suffix = match[2] || '';

		if (method === 'DELETE' && suffix === '') {
			await this.adapter.deleteConnection(connectionId);
			sendJson(response, 204, null, requestId);
			return 204;
		}

		if (method === 'PATCH' && suffix === '') {
			const input = parseJson(body);
			if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled_required');
			const connection = await this.adapter.patchConnection(connectionId, input.enabled);
			sendJson(response, 200, { version: '1.0', connection }, requestId);
			return 200;
		}

		if (method === 'PUT' && suffix === 'credentials') {
			const connections = await this.adapter.listConnections();
			if (!connections.some((entry) => entry.id === connectionId)) {
				throw new HttpError(404, 'connection_not_found');
			}
			const input = parseJson(body);
			const credentials =
				input.credentials &&
				typeof input.credentials === 'object' &&
				!Array.isArray(input.credentials)
					? (input.credentials as Record<string, unknown>)
					: input;
			await this.vault.put(connectionId, credentials);
			sendJson(response, 204, null, requestId);
			return 204;
		}

		if (suffix === 'login' && method === 'POST') {
			const credentials = await this.vault.get(connectionId);
			const connection = await this.adapter.login(connectionId, { credentials });
			let qrCode = null;
			try {
				qrCode = await this.adapter.getQrCode(connectionId);
			} catch (error) {
				if (!(error instanceof AdapterError) || error.statusCode !== 404) throw error;
			}
			sendJson(response, 200, { version: '1.0', connection, qr_code: qrCode }, requestId);
			return 200;
		}

		if (suffix === 'login' && method === 'GET') {
			const connection = (await this.adapter.listConnections()).find(
				(entry) => entry.id === connectionId
			);
			if (!connection) throw new HttpError(404, 'connection_not_found');
			let qrCode = null;
			try {
				qrCode = await this.adapter.getQrCode(connectionId);
			} catch (error) {
				if (!(error instanceof AdapterError) || error.statusCode !== 404) throw error;
			}
			sendJson(response, 200, { version: '1.0', connection, qr_code: qrCode }, requestId);
			return 200;
		}

		if (suffix === 'reconnect' && method === 'POST') {
			const connection = await this.adapter.reconnect(connectionId);
			sendJson(response, 200, { version: '1.0', connection }, requestId);
			return 200;
		}

		if (suffix === 'logout' && method === 'POST') {
			const connection = await this.adapter.logout(connectionId);
			await this.vault.delete(connectionId);
			sendJson(response, 200, { version: '1.0', connection }, requestId);
			return 200;
		}

		if (suffix === 'groups' && method === 'GET') {
			const groups = this.state.listGroups({ connectionId });
			sendJson(response, 200, { version: '1.0', groups }, requestId);
			return 200;
		}

		if (suffix === 'groups/discover' && method === 'POST') {
			const groups = await this.adapter.discoverGroups(connectionId);
			sendJson(response, 200, { version: '1.0', groups }, requestId);
			return 200;
		}

		const groupMatch = suffix.match(/^groups\/([^/]+)$/);
		if (groupMatch && method === 'PATCH') {
			const groupId = decodeSegment(groupMatch[1]!);
			const input = parseJson(body);
			if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled_required');
			const connection = (await this.adapter.listConnections()).find(
				(entry) => entry.id === connectionId
			);
			if (!connection) throw new HttpError(404, 'connection_not_found');
			const group = await this.state.patchGroup(connection.channel, connectionId, groupId, {
				enabled: input.enabled,
				...(typeof input.name === 'string' && input.name.trim()
					? { name: input.name.trim().slice(0, 512) }
					: {})
			});
			if (!group) throw new HttpError(404, 'group_not_found');
			sendJson(response, 200, { version: '1.0', group }, requestId);
			return 200;
		}

		throw new HttpError(404, 'not_found');
	}

	private mapError(error: unknown): { statusCode: number; code: string } {
		if (error instanceof HttpError) return error;
		if (error instanceof AdapterError) {
			return { statusCode: error.statusCode, code: error.code };
		}
		if (error instanceof EventValidationError) {
			return { statusCode: 400, code: error.code };
		}
		return { statusCode: 500, code: 'internal_error' };
	}
}
