import { WEBUI_API_BASE_URL } from '$lib/constants';

const BOT_GATEWAY_API_BASE_URL = `${WEBUI_API_BASE_URL}/bot-gateway`;

export type BotGatewayChannel = 'wechat' | 'qq';

export type BotGatewayConnection = {
	id: string;
	channel: BotGatewayChannel;
	owner_user_id: string | null;
	owner_name: string | null;
	owner_username: string | null;
	owner_email: string | null;
	enabled: boolean;
	status: string;
	configured: boolean;
	credentials_configured: boolean;
	account_id: string | null;
	account_name: string | null;
	last_error: string | null;
	updated_at: number | string | null;
};

export type BotGatewayLoginSession = {
	state: string;
	qr_code: string | null;
	expires_at: number | string | null;
	message: string | null;
};

export type BotGatewayGroup = {
	id: string;
	name: string;
	allowed: boolean;
	member_count: number | null;
	discovered_at: number | string | null;
};

export type BotGatewayBinding = {
	id: string;
	channel: BotGatewayChannel;
	connection_id: string;
	user_id: string;
	user_name?: string | null;
	user_username?: string | null;
	user_email?: string | null;
	external_user_id: string;
	display_name: string | null;
	status: string;
	enabled: boolean;
	blocked: boolean;
	blocked_at: number | string | null;
	blocked_by: string | null;
	unbind_requested_at: number | string | null;
	last_seen_at: number | string | null;
	created_at: number | string | null;
	updated_at: number | string | null;
};

export type BotGatewayBindingCode = {
	code: string;
	channel: BotGatewayChannel | null;
	expires_at: number | string | null;
	expires_in: number | null;
};

export type BotGatewayUserSettings = {
	default_model_id: string | null;
	admin_recommended_model_id: string | null;
	available: boolean;
	qq_enabled: boolean;
	wechat_enabled: boolean;
};

export type BotGatewayUserConnection = {
	channel: BotGatewayChannel;
	configured: boolean;
	status: string;
	account_id: string | null;
	account_name: string | null;
	last_error: string | null;
	updated_at: number | string | null;
};

export type BotGatewayAdminSettings = {
	enabled: boolean;
	qq_enabled: boolean;
	wechat_enabled: boolean;
	recommended_model_id: string | null;
};

export type BotGatewayAuditRecord = {
	id: string;
	action: string;
	channel: BotGatewayChannel | null;
	user_id: string | null;
	account_id: string | null;
	actor_id: string | null;
	created_at: number | string | null;
	detail: string | null;
};

type RequestOptions = Omit<RequestInit, 'body'> & {
	body?: unknown;
};

const errorMessage = (payload: unknown, fallback: string) => {
	if (typeof payload === 'string' && payload) {
		return payload;
	}

	if (payload && typeof payload === 'object') {
		const detail = (payload as { detail?: unknown; message?: unknown }).detail;
		const message = (payload as { message?: unknown }).message;
		if (typeof detail === 'string' && detail) return detail;
		if (typeof message === 'string' && message) return message;
	}

	return fallback;
};

const request = async <T>(
	token: string,
	path: string,
	options: RequestOptions = {}
): Promise<T> => {
	const headers = new Headers(options.headers);
	headers.set('Accept', 'application/json');
	headers.set('authorization', `Bearer ${token}`);

	let body: BodyInit | undefined;
	if (options.body !== undefined) {
		headers.set('Content-Type', 'application/json');
		body = JSON.stringify(options.body);
	}

	const response = await fetch(`${BOT_GATEWAY_API_BASE_URL}${path}`, {
		...options,
		headers,
		body
	});

	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new Error(errorMessage(payload, `Bot Gateway request failed (${response.status})`));
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
};

const asChannel = (value: unknown): BotGatewayChannel => {
	if (value === 'wechat' || value === 'qq') return value;
	throw new Error('Bot Gateway returned an invalid channel.');
};

// Deliberately copy only non-secret fields. Even if a server accidentally includes credentials,
// callers of this module never receive them.
const sanitizeConnection = (value: any): BotGatewayConnection => ({
	id: String(value?.id ?? value?.connection_id ?? value?.channel ?? ''),
	channel: asChannel(value?.channel),
	owner_user_id: value?.owner_user_id == null && value?.ownerUserId == null ? null : String(value?.owner_user_id ?? value?.ownerUserId),
	owner_name:
		value?.owner_name == null && value?.ownerName == null
			? null
			: String(value?.owner_name ?? value?.ownerName),
	owner_username:
		value?.owner_username == null && value?.ownerUsername == null
			? null
			: String(value?.owner_username ?? value?.ownerUsername),
	owner_email:
		value?.owner_email == null && value?.ownerEmail == null
			? null
			: String(value?.owner_email ?? value?.ownerEmail),
	enabled:
		value?.enabled == null ? String(value?.status ?? '') !== 'disabled' : Boolean(value.enabled),
	status: String(value?.status ?? 'disconnected'),
	configured: Boolean(
		value?.configured ?? value?.credentials_configured ?? value?.credentialsConfigured
	),
	credentials_configured: Boolean(
		value?.credentials_configured ?? value?.credentialsConfigured ?? value?.configured
	),
	account_id: value?.account_id == null ? null : String(value.account_id),
	account_name:
		value?.account_name == null && value?.accountLabel == null
			? null
			: String(value?.account_name ?? value?.accountLabel),
	last_error:
		value?.last_error == null && value?.detail == null
			? null
			: String(value?.last_error ?? value?.detail),
	updated_at: value?.updated_at ?? value?.updatedAt ?? null
});

const extractQrCodeValue = (value: unknown, depth = 0): string | null => {
	if (typeof value === 'string' && value.trim()) return value;
	if (!value || typeof value !== 'object' || depth > 4) return null;
	for (const key of [
		'data_url',
		'dataUrl',
		'qr_code',
		'qrCode',
		'qrcode',
		'qrcode_url',
		'qrcodeUrl',
		'url',
		'text',
		'content',
		'value'
	]) {
		const result = extractQrCodeValue((value as Record<string, unknown>)[key], depth + 1);
		if (result) return result;
	}
	return null;
};

const sanitizeLoginSession = (value: any): BotGatewayLoginSession => ({
	state: String(value?.state ?? value?.status ?? 'pending'),
	qr_code: extractQrCodeValue(value?.qr_code ?? value?.qr_code_data_url ?? value?.dataUrl),
	expires_at: value?.expires_at ?? value?.expiresAt ?? null,
	message:
		value?.message == null && value?.detail == null ? null : String(value?.message ?? value?.detail)
});

const sanitizeGroup = (value: any): BotGatewayGroup => ({
	id: String(value?.id ?? value?.group_id ?? value?.groupId ?? ''),
	name: String(
		value?.name ?? value?.group_name ?? value?.groupName ?? value?.id ?? value?.groupId ?? ''
	),
	allowed: Boolean(value?.allowed ?? value?.whitelisted),
	member_count: Number.isFinite(value?.member_count ?? value?.memberCount)
		? Number(value?.member_count ?? value?.memberCount)
		: null,
	discovered_at: value?.discovered_at ?? value?.lastSeenAt ?? null
});

const sanitizeBinding = (value: any): BotGatewayBinding => ({
	id: String(value?.id ?? value?.binding_id ?? ''),
	channel: asChannel(value?.channel),
	connection_id: String(value?.connection_id ?? value?.connectionId ?? ''),
	user_id: String(value?.user_id ?? value?.userId ?? ''),
	user_name: value?.user_name == null && value?.userName == null ? null : String(value?.user_name ?? value?.userName),
	user_username: value?.user_username == null && value?.userUsername == null ? null : String(value?.user_username ?? value?.userUsername),
	user_email: value?.user_email == null && value?.userEmail == null ? null : String(value?.user_email ?? value?.userEmail),
	external_user_id: String(value?.external_user_id ?? value?.externalUserId ?? ''),
	display_name:
		value?.display_name == null && value?.displayName == null
			? null
			: String(value?.display_name ?? value?.displayName),
	status: String(value?.status ?? 'active'),
	enabled: Boolean(value?.enabled ?? value?.status === 'active'),
	blocked: Boolean(value?.blocked ?? value?.status === 'blocked'),
	blocked_at: value?.blocked_at ?? value?.blockedAt ?? null,
	blocked_by:
		value?.blocked_by == null && value?.blockedBy == null
			? null
			: String(value?.blocked_by ?? value?.blockedBy),
	unbind_requested_at: value?.unbind_requested_at ?? value?.unbindRequestedAt ?? null,
	last_seen_at: value?.last_seen_at ?? value?.lastSeenAt ?? null,
	created_at: value?.created_at ?? value?.createdAt ?? null,
	updated_at: value?.updated_at ?? value?.updatedAt ?? null
});

const sanitizeUserSettings = (value: any): BotGatewayUserSettings => ({
	default_model_id: value?.default_model_id ?? value?.defaultModelId ?? null,
	admin_recommended_model_id:
		value?.admin_recommended_model_id ?? value?.recommended_model_id ?? value?.recommendedModelId ?? null,
	available: Boolean(value?.available ?? value?.enabled ?? true),
	qq_enabled: Boolean(value?.qq_enabled ?? value?.qqEnabled ?? true),
	wechat_enabled: Boolean(value?.wechat_enabled ?? value?.wechatEnabled ?? true)
});

const sanitizeUserConnection = (value: any, channel?: BotGatewayChannel): BotGatewayUserConnection => ({
	channel: asChannel(value?.channel ?? channel),
	configured: Boolean(value?.configured ?? value?.credentials_configured),
	status: String(value?.status ?? 'disconnected'),
	account_id: value?.account_id == null ? null : String(value.account_id),
	account_name: value?.account_name == null ? null : String(value.account_name),
	last_error: value?.last_error == null ? null : String(value.last_error),
	updated_at: value?.updated_at ?? null
});

const userConnectionPath = (channel: BotGatewayChannel) => `/user/connections/${channel}`;

const sanitizeAuditRecord = (value: any): BotGatewayAuditRecord => ({
	id: String(value?.id ?? ''),
	action: String(value?.action ?? ''),
	channel: value?.channel ? asChannel(value.channel) : null,
	user_id: value?.user_id == null ? null : String(value.user_id),
	account_id: value?.account_id == null ? null : String(value.account_id),
	actor_id: value?.actor_id == null ? null : String(value.actor_id),
	created_at: value?.created_at ?? value?.createdAt ?? null,
	detail: value?.detail == null ? null : String(value.detail)
});

export const getBotGatewayConnections = async (token: string): Promise<BotGatewayConnection[]> => {
	const payload = await request<any>(token, '/admin/connections');
	const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.connections ?? []);
	return items.map(sanitizeConnection);
};

export const updateBotGatewayConnection = async (
	token: string,
	connectionId: string,
	form: { enabled: boolean }
): Promise<BotGatewayConnection> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}`,
		{ method: 'PATCH', body: form }
	);
	return sanitizeConnection(payload);
};

export const setQQBotCredentials = async (
	token: string,
	connectionId: string,
	form: { app_id: string; app_secret: string }
): Promise<BotGatewayConnection> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/credentials`,
		{ method: 'PUT', body: form }
	);
	return sanitizeConnection(payload);
};

export const beginBotGatewayLogin = async (
	token: string,
	connectionId: string
): Promise<BotGatewayLoginSession> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/login`,
		{ method: 'POST' }
	);
	return sanitizeLoginSession(payload);
};

export const getBotGatewayLoginState = async (
	token: string,
	connectionId: string
): Promise<BotGatewayLoginSession> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/login`
	);
	return sanitizeLoginSession(payload);
};

export const reconnectBotGateway = async (
	token: string,
	connectionId: string
): Promise<BotGatewayConnection> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/reconnect`,
		{ method: 'POST' }
	);
	return sanitizeConnection(payload);
};

export const logoutBotGateway = async (token: string, connectionId: string): Promise<void> => {
	await request<void>(token, `/admin/connections/${encodeURIComponent(connectionId)}/logout`, {
		method: 'POST'
	});
};

export const getBotGatewayGroups = async (
	token: string,
	connectionId: string
): Promise<BotGatewayGroup[]> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/groups`
	);
	const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.groups ?? []);
	return items.map(sanitizeGroup);
};

export const discoverBotGatewayGroups = async (
	token: string,
	connectionId: string
): Promise<BotGatewayGroup[]> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/groups/discover`,
		{ method: 'POST' }
	);
	const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.groups ?? []);
	return items.map(sanitizeGroup);
};

export const updateBotGatewayGroup = async (
	token: string,
	connectionId: string,
	groupId: string,
	form: { allowed: boolean }
): Promise<BotGatewayGroup> => {
	const payload = await request<any>(
		token,
		`/admin/connections/${encodeURIComponent(connectionId)}/groups/${encodeURIComponent(groupId)}`,
		{ method: 'PATCH', body: form }
	);
	return sanitizeGroup(payload);
};

export const createBotGatewayBindingCode = async (
	token: string,
	channel?: BotGatewayChannel
): Promise<BotGatewayBindingCode> => {
	const payload = await request<any>(token, '/bindings/code', {
		method: 'POST',
		body: channel ? { channel } : {}
	});
	return {
		code: String(payload?.code ?? ''),
		channel: payload?.channel ? asChannel(payload.channel) : (channel ?? null),
		expires_at: payload?.expires_at ?? null,
		expires_in: Number.isFinite(payload?.expires_in) ? Number(payload.expires_in) : null
	};
};

export const getBotGatewayBindings = async (token: string): Promise<BotGatewayBinding[]> => {
	const payload = await request<any>(token, '/bindings');
	const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.bindings ?? []);
	return items.map(sanitizeBinding);
};

export const deleteBotGatewayBinding = async (token: string, bindingId: string): Promise<void> => {
	await request<void>(token, `/bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' });
};

export const getAdminBotGatewayBindings = async (token: string): Promise<BotGatewayBinding[]> => {
	const payload = await request<any>(token, '/admin/bindings');
	const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.bindings ?? []);
	return items.map(sanitizeBinding);
};

export const blockAdminBotGatewayBinding = async (
	token: string,
	bindingId: string
): Promise<void> => {
	await request<void>(token, `/admin/bindings/${encodeURIComponent(bindingId)}`, {
		method: 'DELETE'
	});
};

export const unblockAdminBotGatewayBinding = async (
	token: string,
	bindingId: string
): Promise<void> => {
	await request<void>(token, `/admin/bindings/${encodeURIComponent(bindingId)}/unblock`, {
		method: 'POST'
	});
};

// User-owned bot accounts. These endpoints deliberately never return secrets.
export const getBotGatewayUserSettings = async (token: string): Promise<BotGatewayUserSettings> =>
	sanitizeUserSettings(await request<any>(token, '/user/settings'));

export const updateBotGatewayUserSettings = async (
	token: string,
	form: { default_model_id?: string | null }
): Promise<BotGatewayUserSettings> =>
	sanitizeUserSettings(await request<any>(token, '/user/settings', { method: 'PATCH', body: form }));

export const getBotGatewayUserConnections = async (
	token: string
): Promise<BotGatewayUserConnection[]> => {
	const payload = await request<any>(token, '/user/connections');
	const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.connections ?? [];
	return items.map((item: any) => sanitizeUserConnection(item));
};

export const createBotGatewayUserConnection = async (
	token: string,
	channel: BotGatewayChannel
): Promise<BotGatewayUserConnection> =>
	sanitizeUserConnection(
		await request<any>(token, userConnectionPath(channel), { method: 'POST' }),
		channel
	);

export const setBotGatewayUserQQCredentials = async (
	token: string,
	form: { app_id: string; app_secret: string }
): Promise<BotGatewayUserConnection> =>
	sanitizeUserConnection(
		await request<any>(token, '/user/connections/qq/credentials', { method: 'PUT', body: form }),
		'qq'
	);

export const beginBotGatewayUserLogin = async (
	token: string
): Promise<BotGatewayLoginSession> =>
	sanitizeLoginSession(await request<any>(token, '/user/connections/wechat/login', { method: 'POST' }));

export const getBotGatewayUserLoginState = async (
	token: string
): Promise<BotGatewayLoginSession> =>
	sanitizeLoginSession(await request<any>(token, '/user/connections/wechat/login'));

export const logoutBotGatewayUserConnection = async (
	token: string,
	channel: BotGatewayChannel
): Promise<void> => {
	await request<void>(token, `/user/connections/${channel}/logout`, { method: 'POST' });
};

export const getBotGatewayAdminSettings = async (
	token: string
): Promise<BotGatewayAdminSettings> =>
	(await request<any>(token, '/admin/settings')) as BotGatewayAdminSettings;

export const updateBotGatewayAdminSettings = async (
	token: string,
	form: Partial<BotGatewayAdminSettings>
): Promise<BotGatewayAdminSettings> =>
	(await request<any>(token, '/admin/settings', { method: 'PATCH', body: form })) as BotGatewayAdminSettings;

export const getBotGatewayAuditRecords = async (
	token: string
): Promise<BotGatewayAuditRecord[]> => {
	const payload = await request<any>(token, '/admin/audit');
	const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.records ?? [];
	return items.map(sanitizeAuditRecord);
};
