import { describe, expect, it } from 'vitest';

import { getAIErrorDescription, normalizeAIError } from './chatError';

describe('chatError', () => {
	it('normalizes structured backend errors', () => {
		const error = normalizeAIError({
			content: 'Console API returned 429',
			category: 'rate_limited',
			status_code: 429,
			incident_id: 'ERR-20260711-ABCDEF12',
			admin_notification: 'submitted'
		});

		expect(error).toEqual({
			content: 'Console API returned 429',
			technical_detail: undefined,
			category: 'rate_limited',
			status_code: 429,
			incident_id: 'ERR-20260711-ABCDEF12',
			admin_notification: 'submitted',
			notification_suppressed: undefined
		});
	});

	it('supports FastAPI and legacy error shapes', () => {
		expect(
			normalizeAIError({ detail: { content: 'upstream failed', category: 'server_failed' } })
		).toMatchObject({ content: 'upstream failed', category: 'server_failed' });
		expect(normalizeAIError('Console API returned 429')).toMatchObject({
			content: 'Console API returned 429',
			category: 'rate_limited'
		});
	});

	it('maps categories to user-facing descriptions', () => {
		expect(getAIErrorDescription('rate_limited')).toContain('请稍等片刻');
		expect(getAIErrorDescription('context_length_exceeded')).toContain('对话内容过长');
		expect(getAIErrorDescription('unknown_error')).toContain('请先重试一次');
		expect(getAIErrorDescription('response_interrupted')).toContain('意外中断');
		expect(getAIErrorDescription('insufficient_credit')).toContain('积分不足');
		expect(getAIErrorDescription('invalid_request')).toContain('缺少有效的对话内容');
		expect(getAIErrorDescription('payload_too_large')).toContain('内容过大');
		expect(getAIErrorDescription('image_too_large')).toContain('图片尺寸过大');
		expect(getAIErrorDescription('too_many_attachments')).toContain('附件数量');
		expect(getAIErrorDescription('upstream_overloaded')).toContain('负载');
	});

	it('classifies wrapped upstream status codes from gateway messages', () => {
		expect(normalizeAIError('... failed: status=413, body=')).toMatchObject({
			category: 'payload_too_large'
		});
		expect(normalizeAIError('... failed: status=422, body=')).toMatchObject({
			category: 'unprocessable_request'
		});
		expect(
			normalizeAIError('The image requires 33075 patches after processing, exceeding the limit of 30000')
		).toMatchObject({ category: 'image_too_large' });
		expect(normalizeAIError('单次对话最多支持 8 个附件')).toMatchObject({
			category: 'too_many_attachments'
		});
	});

	it('classifies EOF and credit errors before generic status handling', () => {
		expect(normalizeAIError('unexpected EOF')).toMatchObject({
			category: 'response_interrupted'
		});
		expect(normalizeAIError('您的绘图积分不足')).toMatchObject({
			category: 'insufficient_credit'
		});
	});
});
