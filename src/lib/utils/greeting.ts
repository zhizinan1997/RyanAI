const ASSIST_QUESTIONS = [
	'需要我们一起做点什么吗？',
	'今天想先推进哪件事？',
	'要不要一起把下一步理清楚？',
	'现在想从哪里开始？',
	'有什么想让我帮你拆解的吗？',
	'要一起处理代码、写作，还是规划点什么？',
	'今天有什么值得我们马上动手的事？'
];

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

export const getAssistQuestion = (date = new Date()) => {
	const hourlyIndex = Math.floor(date.getTime() / (1000 * 60 * 60));

	return ASSIST_QUESTIONS[hourlyIndex % ASSIST_QUESTIONS.length];
};

export const getGreetingLine = (name = 'Ryan', date = new Date()) => {
	return `${getTimeOfDayGreeting(date)}，${name || 'Ryan'}。${getAssistQuestion(date)}`;
};
