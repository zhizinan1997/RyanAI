import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { RyanAiClient } from '../src/ryanai-client.js';
import { verifyRequest } from '../src/security/hmac.js';
import { inboundEvent, tempDataDir, testConfig } from './helpers.js';

test('RyanAI client sends signed multipart metadata and attachment bytes', async () => {
	const dataDir = await tempDataDir();
	let verified = false;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const result = verifyRequest({
			secret: 'hmac-secret-that-is-definitely-longer-than-32-bytes',
			method: request.method || 'POST',
			pathWithQuery: request.url || '/',
			body,
			timestamp: request.headers['x-ryanai-timestamp'] as string,
			nonce: request.headers['x-ryanai-nonce'] as string,
			contentSha256: request.headers['x-ryanai-content-sha256'] as string,
			signature: request.headers['x-ryanai-signature'] as string,
			maxSkewSeconds: 300
		});
		verified = result.ok;
		assert.equal(request.headers['idempotency-key'], 'multipart-event');
		assert.match(request.headers['content-type'] || '', /^multipart\/form-data; boundary=/);
		assert.equal(body.includes(Buffer.from('report.txt')), true);
		assert.equal(body.includes(Buffer.from('attachment contents')), true);
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				version: '1.0',
				event_id: 'multipart-event',
				status: 'ok',
				reply: { text: 'Ryan reply' }
			})
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const config = testConfig(dataDir, {
		ryanAiBaseUrl: new URL(`http://127.0.0.1:${address.port}`)
	});
	const client = new RyanAiClient(config);
	const result = await client.send(
		inboundEvent({
			eventId: 'multipart-event',
			attachments: [
				{
					id: 'file-1',
					fileName: 'report.txt',
					contentType: 'text/plain',
					bytes: Buffer.from('attachment contents')
				}
			]
		})
	);
	assert.equal(verified, true);
	assert.deepEqual(result, { text: 'Ryan reply' });
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
});
