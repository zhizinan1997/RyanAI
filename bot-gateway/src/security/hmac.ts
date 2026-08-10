import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';

export interface SignableRequest {
	method: string;
	pathWithQuery: string;
	body: Uint8Array;
	timestamp?: string;
	nonce?: string;
}

export interface SignedHeaders {
	'x-ryanai-timestamp': string;
	'x-ryanai-nonce': string;
	'x-ryanai-content-sha256': string;
	'x-ryanai-signature': string;
}

export function sha256Hex(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function canonicalRequest(
	method: string,
	pathWithQuery: string,
	timestamp: string,
	nonce: string,
	contentSha256: string
): string {
	return [
		SIGNATURE_VERSION,
		timestamp,
		nonce,
		method.toUpperCase(),
		pathWithQuery,
		contentSha256
	].join('\n');
}

export function signRequest(secret: string, request: SignableRequest): SignedHeaders {
	const timestamp = request.timestamp || Math.floor(Date.now() / 1_000).toString();
	const nonce = request.nonce || randomUUID();
	const contentSha256 = sha256Hex(request.body);
	const canonical = canonicalRequest(
		request.method,
		request.pathWithQuery,
		timestamp,
		nonce,
		contentSha256
	);
	const digest = createHmac('sha256', secret).update(canonical).digest('hex');
	return {
		'x-ryanai-timestamp': timestamp,
		'x-ryanai-nonce': nonce,
		'x-ryanai-content-sha256': contentSha256,
		'x-ryanai-signature': `${SIGNATURE_VERSION}=${digest}`
	};
}

function equalText(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface VerifyRequestInput {
	secret: string;
	method: string;
	pathWithQuery: string;
	body: Uint8Array;
	timestamp: string | undefined;
	nonce: string | undefined;
	contentSha256: string | undefined;
	signature: string | undefined;
	maxSkewSeconds: number;
	now?: number;
}

export type VerifyRequestResult = { ok: true; nonce: string } | { ok: false; reason: string };

export function verifyRequest(input: VerifyRequestInput): VerifyRequestResult {
	if (!input.timestamp || !input.nonce || !input.contentSha256 || !input.signature) {
		return { ok: false, reason: 'missing_signature_headers' };
	}
	if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.nonce)) {
		return { ok: false, reason: 'invalid_nonce' };
	}

	const timestamp = Number(input.timestamp);
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1_000);
	if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > input.maxSkewSeconds) {
		return { ok: false, reason: 'stale_timestamp' };
	}

	const actualHash = sha256Hex(input.body);
	if (!equalText(actualHash, input.contentSha256.toLowerCase())) {
		return { ok: false, reason: 'content_hash_mismatch' };
	}

	const canonical = canonicalRequest(
		input.method,
		input.pathWithQuery,
		input.timestamp,
		input.nonce,
		actualHash
	);
	const expected = `${SIGNATURE_VERSION}=${createHmac('sha256', input.secret)
		.update(canonical)
		.digest('hex')}`;
	if (!equalText(expected, input.signature.toLowerCase())) {
		return { ok: false, reason: 'signature_mismatch' };
	}
	return { ok: true, nonce: input.nonce };
}

export class NonceReplayCache {
	private readonly entries = new Map<string, number>();

	constructor(private readonly ttlMs: number) {}

	claim(nonce: string, now = Date.now()): boolean {
		for (const [key, expiresAt] of this.entries) {
			if (expiresAt <= now) this.entries.delete(key);
		}
		const existing = this.entries.get(nonce);
		if (existing && existing > now) return false;
		this.entries.set(nonce, now + this.ttlMs);
		return true;
	}
}
