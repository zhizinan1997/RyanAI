import { WEBUI_API_BASE_URL } from '$lib/constants';

export const getMyUsageSummary = async (token: string) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/credit/my/usage-summary`, {
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
			console.log(err);
			error = err.detail;
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const listCreditLog = async (token: string, page: number) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/credit/logs?page=${page}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.catch((err) => {
			console.log(err);
			error = err.detail;
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const listAllCreditLog = async (
	token: string,
	page: number,
	limit: number,
	query: string
) => {
	let error = null;

	const res = await fetch(
		`${WEBUI_API_BASE_URL}/credit/all_logs?page=${page}&limit=${limit}&query=${query}`,
		{
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`
			}
		}
	)
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.catch((err) => {
			console.log(err);
			error = err.detail;
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const getCreditStats = async (token: string, data: object) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/credit/statistics`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(data)
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.catch((err) => {
			console.log(err);
			error = err.detail;
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const deleteCreditLogs = async (token: string, timestamp: number) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/credit/logs`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ timestamp })
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.catch((err) => {
			console.log(err);
			error = err.detail;
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};
