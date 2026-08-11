import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	beginBotGatewayLogin,
	blockAdminBotGatewayBinding,
	createBotGatewayBindingCode,
	deleteBotGatewayBinding,
	getAdminBotGatewayBindings,
	getBotGatewayConnections,
	getBotGatewayLoginState,
	getBotGatewayUserLoginState,
	logoutBotGateway,
	setQQBotCredentials,
	setBotGatewayUserQQCredentials,
	unblockAdminBotGatewayBinding
} from './index';

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});

describe('bot gateway API contract', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses the singular binding-code route and sends the selected channel', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				code: 'ABCDE-23456',
				channel: 'qq',
				expires_at: 1_800_000_000,
				expires_in: 600
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await createBotGatewayBindingCode('token', 'qq');

		const [url, options] = fetchMock.mock.calls[0];
		expect(String(url)).toMatch(/\/bot-gateway\/bindings\/code$/);
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({ channel: 'qq' });
	});

	it('handles every binding and logout 204 response without parsing JSON', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		await deleteBotGatewayBinding('token', 'user/binding');
		await blockAdminBotGatewayBinding('token', 'admin/binding');
		await unblockAdminBotGatewayBinding('token', 'blocked/binding');
		await logoutBotGateway('token', 'qq-default');

		expect(fetchMock.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
			['/api/v1/bot-gateway/bindings/user%2Fbinding', 'DELETE'],
			['/api/v1/bot-gateway/admin/bindings/admin%2Fbinding', 'DELETE'],
			['/api/v1/bot-gateway/admin/bindings/blocked%2Fbinding/unblock', 'POST'],
			['/api/v1/bot-gateway/admin/connections/qq-default/logout', 'POST']
		]);
	});

	it('uses POST to start login and GET to poll the same connection', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => jsonResponse({ state: 'pending', qr_code: 'qr-data' }));
		vi.stubGlobal('fetch', fetchMock);

		await beginBotGatewayLogin('token', 'wechat-default');
		await getBotGatewayLoginState('token', 'wechat-default');

		expect(
			fetchMock.mock.calls.map(([url, options]) => [String(url), options.method ?? 'GET'])
		).toEqual([
			['/api/v1/bot-gateway/admin/connections/wechat-default/login', 'POST'],
			['/api/v1/bot-gateway/admin/connections/wechat-default/login', 'GET']
		]);
	});

	it('normalizes nested QR payloads without turning them into [object Object]', async () => {
		const fetchMock = vi.fn().mockImplementation(async () =>
			jsonResponse({
				state: 'awaiting_scan',
				qr_code: { dataUrl: 'https://liteapp.weixin.qq.com/q/example?qrcode=abc' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const session = await getBotGatewayLoginState('token', 'wechat-default');
		const userSession = await getBotGatewayUserLoginState('token');

		expect(session.qr_code).toBe('https://liteapp.weixin.qq.com/q/example?qrcode=abc');
		expect(userSession.qr_code).toBe('https://liteapp.weixin.qq.com/q/example?qrcode=abc');
	});

	it('normalizes user QQ credential responses and keeps the user endpoint contract', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({ channel: 'qq', configured: true, status: 'degraded' })
		);
		vi.stubGlobal('fetch', fetchMock);

		const connection = await setBotGatewayUserQQCredentials('token', {
			app_id: '123',
			app_secret: 'submitted-once'
		});

		expect(connection).toMatchObject({ channel: 'qq', configured: true, status: 'degraded' });
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/bot-gateway\/user\/connections\/qq\/credentials$/);
	});

	it('returns complete admin binding state while dropping undeclared fields', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse([
				{
					id: 'binding-1',
					channel: 'wechat',
					connection_id: 'wechat-default',
					user_id: 'user-1',
					external_user_id: 'wx-user',
					display_name: 'Alice',
					status: 'blocked',
					enabled: false,
					blocked: true,
					blocked_at: 1_800_000_000,
					blocked_by: 'admin-1',
					unbind_requested_at: null,
					last_seen_at: 1_799_999_999,
					created_at: 1_700_000_000,
					updated_at: 1_800_000_000,
					app_secret: 'must-not-escape'
				}
			])
		);
		vi.stubGlobal('fetch', fetchMock);

		const [binding] = await getAdminBotGatewayBindings('token');

		expect(binding).toMatchObject({
			id: 'binding-1',
			user_id: 'user-1',
			status: 'blocked',
			blocked: true,
			enabled: false
		});
		expect(binding).not.toHaveProperty('app_secret');
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/bot-gateway\/admin\/bindings$/);
	});

	it('never exposes a credential echoed by a misbehaving server', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				id: 'qq-default',
				channel: 'qq',
				enabled: true,
				status: 'connected',
				configured: true,
				credentials_configured: true,
				app_id: '123',
				app_secret: 'must-not-escape'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const connection = await setQQBotCredentials('token', 'qq-default', {
			app_id: '123',
			app_secret: 'submitted-once'
		});

		expect(connection).not.toHaveProperty('app_id');
		expect(connection).not.toHaveProperty('app_secret');
	});

	it('keeps user ownership details on admin connection rows', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse([
				{
					id: 'bot-qq-user-1',
					channel: 'qq',
					owner_user_id: 'user-1',
					owner_name: 'Test User',
					owner_username: 'tester',
					owner_email: 'user@example.com',
					credentials_configured: true
				}
			])
		);
		vi.stubGlobal('fetch', fetchMock);

		const [connection] = await getBotGatewayConnections('token');

		expect(connection.owner_user_id).toBe('user-1');
		expect(connection.owner_name).toBe('Test User');
		expect(connection.owner_username).toBe('tester');
		expect(connection.owner_email).toBe('user@example.com');
	});
});
