import { afterEach, describe, expect, it, vi } from 'vitest';

import { resendSignupVerification, verifySignupEmail } from './index';

describe('signup email verification API', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('submits the email and six-digit verification code', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ token: 'new-token', role: 'user' })
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await verifySignupEmail('user@example.com', '123456');

		expect(result).toMatchObject({ token: 'new-token', role: 'user' });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, options] = fetchMock.mock.calls[0];
		expect(String(url)).toMatch(/\/auths\/signup_verify$/);
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({ email: 'user@example.com', code: '123456' });
	});

	it('uses the current token when resending a verification code', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ status: true })
		});
		vi.stubGlobal('fetch', fetchMock);

		await resendSignupVerification('pending-token');

		const [url, options] = fetchMock.mock.calls[0];
		expect(String(url)).toMatch(/\/auths\/signup_verify\/resend$/);
		expect(options.headers.Authorization).toBe('Bearer pending-token');
	});
});
