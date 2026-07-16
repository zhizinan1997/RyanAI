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
		expect(getAIErrorDescription('rate_limited')).toContain('too many requests');
		expect(getAIErrorDescription('context_length_exceeded')).toContain('context limit');
		expect(getAIErrorDescription('unknown_error')).toContain('system error');
		expect(getAIErrorDescription('response_interrupted')).toContain('retry once');
		expect(getAIErrorDescription('insufficient_credit')).toContain('enough credit');
		expect(getAIErrorDescription('invalid_request')).toContain('missing valid conversation content');
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
