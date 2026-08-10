import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { assertSupportedNode, loadConfig, parseEncryptionKey } from '../src/config.js';

test('configuration follows the fixed environment contract', () => {
	const key = Buffer.alloc(32, 3).toString('base64');
	const config = loadConfig({
		BOT_GATEWAY_ENABLED: 'true',
		BOT_GATEWAY_INTERNAL_PORT: '8787',
		BOT_GATEWAY_HMAC_SECRET: 'a-secret-with-at-least-thirty-two-characters',
		BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY: key,
		BOT_GATEWAY_DATA_DIR: '/data',
		RYANAI_BASE_URL: 'http://ryanai:8080',
		BOT_GATEWAY_WECHAT_ENABLED: 'true',
		BOT_GATEWAY_QQ_ENABLED: 'false'
	});

	assert.equal(config.internalPort, 8787);
	assert.equal(config.dataDir, path.resolve('/data'));
	assert.equal(config.ryanAiBaseUrl.origin, 'http://ryanai:8080');
	assert.equal(config.eventPath, '/api/v1/internal/bot-gateway/events');
	assert.deepEqual([...config.enabledChannels], ['wechat']);
	assert.equal(config.adapterMode, 'openclaw');
});

test('secrets are mandatory and encryption key must be 32 bytes', () => {
	assert.throws(() =>
		loadConfig({
			BOT_GATEWAY_ENABLED: 'true',
			BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64')
		})
	);
	assert.throws(() => parseEncryptionKey('short'));
	assert.deepEqual(parseEncryptionKey('11'.repeat(32)), Buffer.alloc(32, 0x11));
});

test('disabled mode does not require either secret', () => {
	const config = loadConfig({ BOT_GATEWAY_ENABLED: 'false' });
	assert.equal(config.enabled, false);
	assert.equal(config.hmacSecret, '');
	assert.equal(config.credentialsEncryptionKey.length, 0);
});

test('Node minimum version is enforced', () => {
	assert.doesNotThrow(() => assertSupportedNode('22.22.3'));
	assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
	assert.throws(() => assertSupportedNode('22.22.2'));
});
