import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';

import type { GatewayControlPlaneClient } from '../src/control-plane-client.js';
import { createRuntime } from '../src/runtime.js';
import { signRequest } from '../src/security/hmac.js';
import { quietLogger, tempDataDir, testConfig } from './helpers.js';

function signedOptions(
	secret: string,
	method: string,
	path: string,
	payload?: unknown,
	nonce?: string
): RequestInit {
	const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
	const signed = signRequest(secret, { method, pathWithQuery: path, body, nonce });
	return {
		method,
		headers: {
			...signed,
			...(payload === undefined ? {} : { 'content-type': 'application/json' })
		},
		...(payload === undefined ? {} : { body })
	};
}

test('canonical control API paths require HMAC and drive the mock adapter', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const runtime = await createRuntime(config, {
		transport: {
			async send() {
				return { text: 'Ryan mock response' };
			}
		}
	});
	assert.equal(runtime.enabled, true);
	if (!runtime.enabled) throw new Error('expected enabled runtime');
	const port = await runtime.start();
	const origin = `http://127.0.0.1:${port}`;
	try {
		assert.equal((await fetch(`${origin}/health`)).status, 200);
		assert.equal((await fetch(`${origin}/v1/connections`)).status, 401);

		const listPath = '/v1/connections';
		const listResponse = await fetch(
			`${origin}${listPath}`,
			signedOptions(config.hmacSecret, 'GET', listPath)
		);
		assert.equal(listResponse.status, 200);
		assert.equal(((await listResponse.json()) as { connections: unknown[] }).connections.length, 2);

		const credentialsPath = '/v1/connections/qq-default/credentials';
		assert.equal(
			(
				await fetch(
					`${origin}${credentialsPath}`,
					signedOptions(config.hmacSecret, 'PUT', credentialsPath, {
						app_id: 'mock-id',
						app_secret: 'mock-secret'
					})
				)
			).status,
			204
		);
		assert.deepEqual(await runtime.vault.get('qq-default'), {
			app_id: 'mock-id',
			app_secret: 'mock-secret'
		});
		assert.equal((await runtime.state.getConnection('qq-default'))?.credentialsConfigured, true);

		const loginPath = '/v1/connections/qq-default/login';
		const loginResponse = await fetch(
			`${origin}${loginPath}`,
			signedOptions(config.hmacSecret, 'POST', loginPath)
		);
		assert.equal(loginResponse.status, 200);
		const login = (await loginResponse.json()) as { qr_code: { mock: boolean } };
		assert.equal(login.qr_code.mock, true);

		const eventPath = '/v1/mock/events';
		const groupEvent = {
			event_id: 'control-group-1',
			channel: 'qq',
			connection_id: 'qq-default',
			conversation: { type: 'group', id: 'group-control', name: 'Control Group' },
			sender: { id: 'member' },
			message: { text: 'hello', mentions_bot: true }
		};
		const first = await fetch(
			`${origin}${eventPath}`,
			signedOptions(config.hmacSecret, 'POST', eventPath, groupEvent)
		);
		assert.equal(first.status, 200);
		assert.deepEqual(((await first.json()) as { reply: { chunks: string[] } }).reply.chunks, []);

		const groupsPath = '/v1/connections/qq-default/groups';
		const groupsResponse = await fetch(
			`${origin}${groupsPath}`,
			signedOptions(config.hmacSecret, 'GET', groupsPath)
		);
		assert.equal(groupsResponse.status, 200);
		assert.equal(((await groupsResponse.json()) as { groups: unknown[] }).groups.length, 1);

		const patchGroupPath = '/v1/connections/qq-default/groups/group-control';
		const patchGroup = await fetch(
			`${origin}${patchGroupPath}`,
			signedOptions(config.hmacSecret, 'PATCH', patchGroupPath, { enabled: true })
		);
		assert.equal(patchGroup.status, 200);

		const second = await fetch(
			`${origin}${eventPath}`,
			signedOptions(config.hmacSecret, 'POST', eventPath, {
				...groupEvent,
				event_id: 'control-group-2'
			})
		);
		assert.equal(second.status, 200);
		assert.equal(
			((await second.json()) as { reply: { chunks: string[] } }).reply.chunks.join(''),
			'Ryan mock response'
		);

		const replayNonce = 'nonce-control-replay-12345';
		const replayOptions = signedOptions(config.hmacSecret, 'GET', listPath, undefined, replayNonce);
		assert.equal((await fetch(`${origin}${listPath}`, replayOptions)).status, 200);
		assert.equal((await fetch(`${origin}${listPath}`, replayOptions)).status, 409);
	} finally {
		await runtime.stop();
	}
});

test('disabled mode starts health only without initializing state or vault', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, {
		enabled: false,
		hmacSecret: '',
		credentialsEncryptionKey: Buffer.alloc(0)
	});
	const runtime = await createRuntime(config);
	assert.equal(runtime.enabled, false);
	const port = await runtime.start();
	try {
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		assert.equal(health.status, 200);
		assert.equal(((await health.json()) as { status: string }).status, 'disabled');
		const control = await fetch(`http://127.0.0.1:${port}/v1/connections`);
		assert.equal(control.status, 503);
		assert.equal(((await control.json()) as { error: { code: string } }).error.code, 'disabled');
		assert.deepEqual(await readdir(dataDir), []);
	} finally {
		await runtime.stop();
	}
});

test('single-node runtime starts when the initial desired-state sync fails', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const calls: string[] = [];
	const controlPlane = {
		async syncDesiredState() {
			calls.push('sync');
			throw new Error('control_plane_unavailable');
		},
		async registerNode() {
			calls.push('register');
		},
		async heartbeat() {
			calls.push('heartbeat');
		}
	} as unknown as GatewayControlPlaneClient;
	const runtime = await createRuntime(config, {
		controlPlane,
		logger: quietLogger()
	});
	assert.equal(runtime.enabled, true);
	if (!runtime.enabled) throw new Error('expected enabled runtime');

	try {
		const port = await runtime.start();
		assert.ok(port > 0);
		assert.equal(calls[0], 'sync');
		assert.equal((await runtime.state.listConnections()).length, 2);
	} finally {
		await runtime.stop();
	}
});
