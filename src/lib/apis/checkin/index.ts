import { WEBUI_API_BASE_URL } from '$lib/constants';

const request = async <T>(token: string, path: string, init: RequestInit = {}): Promise<T> => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/checkin${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(init.headers ?? {})
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.catch((err) => {
			error = err.detail ?? err;
			return null;
		});
	if (error) throw error;
	return res as T;
};

export type CheckinConfig = {
	checkin_enabled: boolean;
	checked_in_today: boolean;
};

export const getCheckinConfig = (token: string) => request<CheckinConfig>(token, '/config');

export const checkin = (token: string) =>
	request<{ reward: number; checked_in_today: boolean }>(token, '/checkin', { method: 'POST' });

export const getCheckinHistory = (token: string) =>
	request<
		Array<{
			checkin_date: string;
			reward: number;
			created_at: number;
			type: 'checkin';
		}>
	>(token, '/history');

export const getCheckinAdminConfig = (token: string) =>
	request<{
		ENABLE_DAILY_CHECKIN: boolean;
		DAILY_CHECKIN_REWARD_CONFIG: string;
		CHECKIN_TIMEZONE: string;
		ENABLE_DAILY_CREDIT_RESET: boolean;
		DAILY_RESET_CREDIT: string;
	}>(token, '/admin/config');

export const setCheckinAdminConfig = (token: string, config: object) =>
	request(token, '/admin/config', {
		method: 'POST',
		body: JSON.stringify(config)
	});

export const getCheckinRecords = (token: string, page: number = 1, keyword: string = '') => {
	const params = new URLSearchParams({ page: `${page}` });
	if (keyword) params.set('keyword', keyword);
	return request<{
		total: number;
		page: number;
		limit: number;
		items: Array<{
			id: string;
			user_id: string;
			name: string;
			email: string;
			checkin_date: string;
			reward: number;
			created_at: number;
			type: 'checkin';
		}>;
	}>(token, `/admin/records?${params.toString()}`);
};
