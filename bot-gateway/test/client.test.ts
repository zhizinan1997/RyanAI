import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { OpenClawBridgeClient } from '../src/openclaw/bridge-client.js';
import { parseOpenClawBridgeEvent } from '../src/openclaw/bridge-server.js';
import { buildEventMultipart } from '../src/ryanai-client.js';
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
				reply: {
					text: 'Privacy notice\n\nUsage tutorial',
					messages: ['Privacy notice', 'Usage tutorial']
				}
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
	assert.deepEqual(result, {
		text: 'Privacy notice\n\nUsage tutorial',
		messages: ['Privacy notice', 'Usage tutorial']
	});
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
});

test('OpenClaw bridge client lets undici calculate content length', async () => {
	const dataDir = await tempDataDir();
	let requestHeaders: HeadersInit | undefined;
	const fetchImpl: typeof fetch = async (_input, init) => {
		requestHeaders = init?.headers;
		return new Response(
			JSON.stringify({
				version: '1.0',
				reply: {
					handled: true,
					eventId: 'bridge-event',
					chunks: ['bridge reply'],
					isError: false,
					replayed: false,
					reason: 'ryanai'
				}
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	};
	const client = new OpenClawBridgeClient(testConfig(dataDir), fetchImpl);
	const result = await client.forward(inboundEvent({ eventId: 'bridge-event' }));
	assert.deepEqual(result.chunks, ['bridge reply']);
	assert.ok(requestHeaders);
	const normalized = new Headers(requestHeaders);
	assert.equal(normalized.has('content-length'), false);
	await rm(dataDir, { recursive: true, force: true });
});

test('OpenClaw bridge multipart round-trips multiple binary files and Unicode names', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const event = inboundEvent({
		eventId: 'bridge-attachments',
		attachments: [
			{
				id: 'image-1',
				fileName: '微信图片.png',
				contentType: 'image/png',
				bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
			},
			{
				id: 'file-1',
				fileName: '实验记录.docx',
				contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 4, 3, 2, 1])
			}
		]
	});
	const multipart = buildEventMultipart(event);
	const parsed = await parseOpenClawBridgeEvent(multipart.body, multipart.contentType, config);

	assert.deepEqual(
		parsed.attachments.map(({ id, fileName, contentType, bytes }) => ({
			id,
			fileName,
			contentType,
			bytes
		})),
		event.attachments
	);
	await rm(dataDir, { recursive: true, force: true });
});
