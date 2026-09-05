import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBackendConfig } from './index';

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});

describe('backend config API', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses the current session token when loading authenticated configuration', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: true }));
		vi.stubGlobal('fetch', fetchMock);

		await getBackendConfig('session-token');

		const [, options] = fetchMock.mock.calls[0];
		expect(options.headers.authorization).toBe('Bearer session-token');
		expect(options.credentials).toBe('include');
	});

	it('keeps the initial pre-auth configuration request anonymous', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: true }));
		vi.stubGlobal('fetch', fetchMock);

		await getBackendConfig();

		const [, options] = fetchMock.mock.calls[0];
		expect(options.headers).not.toHaveProperty('authorization');
	});
});
