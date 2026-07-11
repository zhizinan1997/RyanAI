export type AIErrorNotificationStatus = 'submitted' | 'disabled' | 'failed';

export type AIErrorPayload = {
	content: string;
	category?: string;
	status_code?: number | null;
	incident_id?: string;
	admin_notification?: AIErrorNotificationStatus;
	notification_suppressed?: boolean;
};

const categoryFromContent = (content: string): string => {
	const marker = content.toLowerCase();
	if (
		/\b429\b/.test(marker) ||
		marker.includes('rate limit') ||
		marker.includes('too many requests')
	) {
		return 'rate_limited';
	}
	if (
		/\b(401|403)\b/.test(marker) ||
		marker.includes('unauthorized') ||
		marker.includes('invalid api key')
	) {
		return 'authentication_failed';
	}
	if (/\b404\b/.test(marker) && marker.includes('model')) return 'model_not_found';
	if (marker.includes('context length') || marker.includes('too many tokens')) {
		return 'context_length_exceeded';
	}
	if (marker.includes('content filter') || marker.includes('safety policy'))
		return 'content_filtered';
	if (marker.includes('timeout') || marker.includes('timed out')) return 'timeout';
	if (marker.includes('network error') || marker.includes('connection refused'))
		return 'network_error';
	if (marker.includes('tool-call limit') || marker.includes('tool failed')) return 'tool_failed';
	if (/\b5\d{2}\b/.test(marker)) return 'server_failed';
	if (marker.includes('model not found')) return 'model_not_found';
	return 'unknown_error';
};

export const normalizeAIError = (value: unknown): AIErrorPayload => {
	if (typeof value === 'string') {
		return { content: value, category: categoryFromContent(value) };
	}

	if (!value || typeof value !== 'object') {
		const content = String(value ?? '');
		return { content, category: categoryFromContent(content) };
	}

	const candidate = value as Record<string, any>;
	if (candidate.detail && typeof candidate.detail === 'object') {
		return normalizeAIError(candidate.detail);
	}
	if (candidate.error && typeof candidate.error === 'object' && !candidate.content) {
		return normalizeAIError(candidate.error);
	}

	const content = String(
		candidate.content ??
			candidate.message ??
			candidate.detail ??
			candidate.error ??
			JSON.stringify(candidate)
	);
	return {
		content,
		category: candidate.category ?? categoryFromContent(content),
		status_code: candidate.status_code ?? null,
		incident_id: candidate.incident_id,
		admin_notification: candidate.admin_notification,
		notification_suppressed: candidate.notification_suppressed
	};
};

export const getAIErrorDescription = (category?: string): string => {
	switch (category) {
		case 'rate_limited':
			return 'The model service is receiving too many requests and cannot answer right now. Please try again later.';
		case 'authentication_failed':
			return 'The model service authentication failed. An administrator needs to check the service credentials.';
		case 'model_not_found':
			return 'The selected model is unavailable or incorrectly configured. Please select another model or try again later.';
		case 'server_failed':
			return 'The model service is temporarily unavailable. Please try again later.';
		case 'timeout':
			return 'The model took too long to respond and the request timed out. Please try again.';
		case 'network_error':
			return 'The system could not connect to the model service. Please try again later.';
		case 'context_length_exceeded':
			return 'This conversation exceeds the model context limit. Please shorten the conversation or start a new chat.';
		case 'content_filtered':
			return 'The request was rejected by the model service safety policy. Please revise the request and try again.';
		case 'tool_failed':
			return 'A tool or external service required for this answer failed. Please try again.';
		default:
			return 'The AI response could not be completed because of a system error. Please try again later.';
	}
};
