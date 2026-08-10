import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { GatewayConfig } from './config.js';
import { Logger } from './logger.js';

export class DisabledControlServer {
	private server: Server | undefined;

	constructor(
		private readonly config: GatewayConfig,
		private readonly logger: Logger
	) {}

	async start(): Promise<number> {
		this.server = createServer((request, response) => {
			const requestId = randomUUID();
			const pathname = new URL(request.url || '/', 'http://bot-gateway.internal').pathname;
			const statusCode = pathname === '/health' ? 200 : pathname.startsWith('/v1/') ? 503 : 404;
			const payload =
				pathname === '/health'
					? { version: '1.0', status: 'disabled', enabled: false }
					: pathname.startsWith('/v1/')
						? { version: '1.0', error: { code: 'disabled' }, request_id: requestId }
						: { version: '1.0', error: { code: 'not_found' }, request_id: requestId };
			const body = Buffer.from(JSON.stringify(payload));
			response.writeHead(statusCode, {
				'content-type': 'application/json; charset=utf-8',
				'content-length': body.length,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'none'",
				'x-request-id': requestId
			});
			response.end(body);
		});
		this.server.requestTimeout = 10_000;
		this.server.headersTimeout = 5_000;
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(this.config.internalPort, this.config.host, () => {
				this.server!.off('error', reject);
				resolve();
			});
		});
		const address = this.server.address();
		const port = typeof address === 'object' && address ? address.port : this.config.internalPort;
		this.logger.info('Bot Gateway is disabled', { host: this.config.host, port });
		return port;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}
