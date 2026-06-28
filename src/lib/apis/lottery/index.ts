import { WEBUI_API_BASE_URL } from '$lib/constants';

export const getLotteryConfig = async (token: string) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/config`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};

export const drawTarot = async (token: string) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/draw`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};

export const checkinLottery = async (token: string) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/checkin`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};

export const getLotteryHistory = async (token: string) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/history`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};

// ───────── admin ─────────

export const getLotteryAdminConfig = async (token: string) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/admin/config`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};

export const setLotteryAdminConfig = async (token: string, config: object) => {
	let error = null;
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/admin/config`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify(config)
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
	return res;
};

export const getLotteryDraws = async (token: string, page: number = 1, keyword: string = '') => {
	let error = null;
	const params = new URLSearchParams({ page: `${page}` });
	if (keyword) params.set('keyword', keyword);
	const res = await fetch(`${WEBUI_API_BASE_URL}/lottery/admin/draws?${params.toString()}`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
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
	return res;
};
