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
