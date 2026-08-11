import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Logger } from '../src/logger.js';
import { NonceReplayCache, signRequest, verifyRequest } from '../src/security/hmac.js';
import { CredentialVault } from '../src/security/vault.js';
import { tempDataDir } from './helpers.js';

test('HMAC signs method, exact path/query, timestamp, nonce and raw body', () => {
	const secret = 'secret-long-enough-for-the-test-signature';
	const body = Buffer.from('{"ok":true}');
	const headers = signRequest(secret, {
		method: 'PATCH',
		pathWithQuery: '/v1/connections/qq-default?x=1',
		body,
		timestamp: '1700000000',
		nonce: 'nonce-1234567890abcdef'
	});
	assert.deepEqual(
		verifyRequest({
			secret,
			method: 'PATCH',
			pathWithQuery: '/v1/connections/qq-default?x=1',
			body,
			timestamp: headers['x-ryanai-timestamp'],
			nonce: headers['x-ryanai-nonce'],
			contentSha256: headers['x-ryanai-content-sha256'],
			signature: headers['x-ryanai-signature'],
			maxSkewSeconds: 5,
			now: 1_700_000_000_000
		}),
		{ ok: true, nonce: 'nonce-1234567890abcdef' }
	);
	assert.equal(
		verifyRequest({
			secret,
			method: 'PATCH',
			pathWithQuery: '/v1/connections/changed',
			body,
			timestamp: headers['x-ryanai-timestamp'],
			nonce: headers['x-ryanai-nonce'],
			contentSha256: headers['x-ryanai-content-sha256'],
			signature: headers['x-ryanai-signature'],
			maxSkewSeconds: 5,
			now: 1_700_000_000_000
		}).ok,
		false
	);
});

test('nonce replay cache rejects a duplicate within its TTL', () => {
	const cache = new NonceReplayCache(1_000);
	assert.equal(cache.claim('nonce', 100), true);
	assert.equal(cache.claim('nonce', 200), false);
	assert.equal(cache.claim('nonce', 1_101), true);
});

test('credential vault encrypts at rest and authenticates connection identity', async () => {
	const dataDir = await tempDataDir();
	const vault = new CredentialVault(dataDir, Buffer.alloc(32, 9));
	await vault.initialize();
	await vault.put('qq-default', { app_id: '123', app_secret: 'very-secret' });
	assert.deepEqual(await vault.get('qq-default'), {
		app_id: '123',
		app_secret: 'very-secret'
	});
	assert.equal(await vault.get('wechat-default'), undefined);
	await vault.delete('qq-default');
	assert.equal(await vault.get('qq-default'), undefined);
});

test('credential vault quarantines a corrupt envelope but still fails closed on a bad key', async () => {
	const dataDir = await tempDataDir();
	const vault = new CredentialVault(dataDir, Buffer.alloc(32, 9));
	await vault.initialize();
	await vault.put('qq-default', { app_id: '123', app_secret: 'very-secret' });

	const envelopePath = path.join(
		dataDir,
		'credentials',
		`${createHash('sha256').update('qq-default').digest('hex')}.json`
	);
	const envelope = JSON.parse(await readFile(envelopePath, 'utf8')) as Record<string, unknown>;

	// A half-written file must read as "no credentials" so the connection asks for
	// a fresh login instead of wedging every later read behind a parse error.
	await writeFile(envelopePath, '{"version":1,"iv":"AAAA","tag":');
	assert.equal(await vault.get('qq-default'), undefined);
	assert.equal(await readFile(`${envelopePath}.corrupt`, 'utf8'), '{"version":1,"iv":"AAAA","tag":');

	// A well-formed envelope that does not authenticate means a wrong master key or
	// tampering, which must surface rather than silently logging the user out.
	await writeFile(
		envelopePath,
		JSON.stringify({ ...envelope, ciphertext: Buffer.from('tampered').toString('base64') })
	);
	await assert.rejects(() => vault.get('qq-default'));
});

test('structured logger redacts credentials, tokens and buffers', () => {
	const lines: string[] = [];
	const logger = new Logger('test', { write: (line) => lines.push(line) });
	logger.info('redaction', {
		credentials: { app_secret: 'leak' },
		authorization: 'Bearer leak',
		payload: Buffer.from('hidden'),
		event_id: 'visible'
	});
	assert.equal(lines.length, 1);
	assert.equal(lines[0]!.includes('leak'), false);
	assert.equal(lines[0]!.includes('hidden'), false);
	assert.equal(lines[0]!.includes('visible'), true);
});
