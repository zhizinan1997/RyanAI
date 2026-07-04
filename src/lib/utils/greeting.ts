export const getTimeOfDayGreeting = (date = new Date()) => {
	const hour = date.getHours();

	if (hour >= 5 && hour < 11) {
		return '早上好';
	}

	if (hour >= 11 && hour < 13) {
		return '中午好';
	}

	if (hour >= 13 && hour < 18) {
		return '下午好';
	}

	if (hour >= 18 && hour < 22) {
		return '晚上好';
	}

	if (hour >= 22) {
		return '夜深了';
	}

	return '凌晨好';
};

const getFirstName = (name = 'Ryan') => {
	return (name || 'Ryan').trim().split(/\s+/)[0] || 'Ryan';
};

export const getGreetingLine = (name = 'Ryan', date = new Date()) => {
	return `${getTimeOfDayGreeting(date)}，${getFirstName(name)}`;
};
