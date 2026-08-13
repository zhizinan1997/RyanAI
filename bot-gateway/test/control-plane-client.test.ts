import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { GatewayControlPlaneClient } from '../src/control-plane-client.js';
import { verifyRequest } from '../src/security/hmac.js';
import { tempDataDir, testConfig } from './helpers.js';

test('control-plane credential storage signs the connection-scoped POST body', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { ryanAiBaseUrl: new URL('http://ryanai.test') });
	let requested = false;
	const fetchImpl: typeof fetch = async (input, init) => {
		requested = true;
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const body = Buffer.from(init?.body as Uint8Array);
		const headers = new Headers(init?.headers);
		assert.equal(init?.method, 'POST');
		assert.equal(url.pathname, '/api/v1/internal/bot-gateway/credentials/qq%2Fuser');
		assert.deepEqual(JSON.parse(body.toString()), {
			channel: 'qq',
			credentials: { appId: 'app-1', appSecret: 'secret-1' }
		});
		assert.deepEqual(
			verifyRequest({
				secret: config.hmacSecret,
				method: init?.method || 'GET',
				pathWithQuery: `${url.pathname}${url.search}`,
				body,
				timestamp: headers.get('x-ryanai-timestamp') ?? undefined,
				nonce: headers.get('x-ryanai-nonce') ?? undefined,
				contentSha256: headers.get('x-ryanai-content-sha256') ?? undefined,
				signature: headers.get('x-ryanai-signature') ?? undefined,
				maxSkewSeconds: config.signatureMaxSkewSeconds
			}),
			{ ok: true, nonce: headers.get('x-ryanai-nonce') }
		);
		return new Response(JSON.stringify({ version: '1.0', stored: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
	const client = new GatewayControlPlaneClient(config, fetchImpl);

	await client.storeCredential('qq/user', 'qq', { appId: 'app-1', appSecret: 'secret-1' });

	assert.equal(requested, true);
	await rm(dataDir, { recursive: true, force: true });
});
