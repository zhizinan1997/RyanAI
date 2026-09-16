export type AIErrorNotificationStatus = 'submitted' | 'disabled' | 'failed' | 'not_required';

export type AIErrorPayload = {
	content: string;
	technical_detail?: string;
	category?: string;
	status_code?: number | null;
	incident_id?: string;
	admin_notification?: AIErrorNotificationStatus;
	notification_suppressed?: boolean;
};

const categoryFromContent = (content: string): string => {
	const marker = content.toLowerCase();
	if (
		marker.includes('积分不足') ||
		marker.includes('余额不足') ||
		marker.includes('insufficient credit') ||
		marker.includes('not enough credit')
	) {
		return 'insufficient_credit';
	}
	if (
		marker.includes('unexpected eof') ||
		marker.includes('stream ended: reason=eof') ||
		marker.includes('response body closed') ||
		marker.includes('stream disconnected') ||
		marker.includes('stream closed before response.completed') ||
		marker.includes('internal_error; received from peer') ||
		marker.includes('stream error: stream id')
	) {
		return 'response_interrupted';
	}
	if (
		marker.includes('最多支持') ||
		marker.includes('附件数量') ||
		marker.includes('附件过多') ||
		marker.includes('too many attachments') ||
		marker.includes('attachment limit')
	) {
		return 'too_many_attachments';
	}
	if (
		marker.includes('patches after processing') ||
		marker.includes('exceeding the limit') ||
		marker.includes('resize the image') ||
		marker.includes('图片过大') ||
		marker.includes('image too large')
	) {
		return 'image_too_large';
	}
	if (
		marker.includes('field messages is required') ||
		marker.includes('messages is required') ||
		marker.includes('缺少有效的对话内容')
	) {
		return 'invalid_request';
	}
	if (
		marker.includes('overloaded') ||
		marker.includes('server_is_overloaded') ||
		marker.includes('负载过高') ||
		marker.includes('服务繁忙')
	) {
		return 'upstream_overloaded';
	}
	if (
		/\b413\b/.test(marker) ||
		marker.includes('payload too large') ||
		marker.includes('request entity too large') ||
		marker.includes('内容过大')
	) {
		return 'payload_too_large';
	}
	if (/\b422\b/.test(marker) || marker.includes('unprocessable')) {
		return 'unprocessable_request';
	}
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
		technical_detail: candidate.technical_detail,
		category: candidate.category ?? categoryFromContent(content),
		status_code: candidate.status_code ?? null,
		incident_id: candidate.incident_id,
		admin_notification: candidate.admin_notification,
		notification_suppressed: candidate.notification_suppressed
	};
};

export const getAIErrorDescription = (category?: string): string => {
	switch (category) {
		case 'payload_too_large':
			return '本次发送的内容过大（图片、附件或对话上下文过多），模型服务拒绝了这次请求。请减少附件数量、压缩图片，或新建对话后重试。';
		case 'image_too_large':
			return '本次发送的图片尺寸过大，模型无法处理。请将图片压缩到约 2000 像素以内（或减少图片数量）后重试。';
		case 'too_many_attachments':
			return '一次对话发送的附件数量超出上限。请减少附件数量，分几次发送后重试。';
		case 'unprocessable_request':
			return '模型服务无法处理本次请求（通常与发送的图片或附件有关）。请尝试更换图片或减少附件后重试；如果仍然失败，请新建对话。';
		case 'upstream_overloaded':
			return '模型服务当前负载较高，暂时无法响应。请稍等片刻后重试，或切换其他模型。';
		case 'response_interrupted':
			return 'AI 回答在传输过程中意外中断。请先重试一次；如果仍然失败，请切换模型或新建对话后再试。';
		case 'insufficient_credit':
			return '当前积分不足，暂时无法完成本次请求。请获取积分后再试。';
		case 'invalid_request':
			return '本次请求缺少有效的对话内容。请刷新页面后重试一次；如果仍然失败，请新建对话。';
		case 'rate_limited':
			return '当前使用人数较多，请稍等片刻后重试一次。';
		case 'authentication_failed':
			return '模型服务配置异常，请联系管理员处理。';
		case 'model_not_found':
			return '当前模型暂不可用，请切换其他模型后重试。';
		case 'server_failed':
			return '模型服务暂时异常。请先重试一次；如果仍然失败，请切换模型。';
		case 'timeout':
			return 'AI 响应时间过长。请先重试一次；如果仍然失败，请切换模型。';
		case 'network_error':
			return '暂时无法连接模型服务。请稍后重试一次。';
		case 'context_length_exceeded':
			return '当前对话内容过长，请精简内容或新建对话后重试。';
		case 'content_filtered':
			return '请求内容未通过模型的安全检查，请修改内容后重试。';
		case 'tool_failed':
			return '回答所需的工具执行失败。请重试一次；如果仍然失败，请关闭相关工具后再试。';
		default:
			return 'AI 未能完成本次回答。请先重试一次；如果仍然失败，请切换模型或新建对话。';
	}
};
