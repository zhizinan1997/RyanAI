import type { GatewayInboundEvent } from '../types.js';

export interface OpenClawCacheKeys {
	runId?: string;
	sessionKey?: string;
}

export class PendingMessageCache {
	private readonly entries = new Map<string, { event: GatewayInboundEvent; expiresAt: number }>();

	constructor(private readonly ttlMs = 10 * 60_000) {}

	put(keys: OpenClawCacheKeys, event: GatewayInboundEvent, now = Date.now()): void {
		this.purge(now);
		for (const key of this.keys(keys)) {
			this.entries.set(key, { event, expiresAt: now + this.ttlMs });
		}
	}

	take(keys: OpenClawCacheKeys, now = Date.now()): GatewayInboundEvent | undefined {
		this.purge(now);
		for (const key of this.keys(keys)) {
			const entry = this.entries.get(key);
			if (!entry) continue;
			for (const [candidate, value] of this.entries) {
				if (value.event === entry.event) this.entries.delete(candidate);
			}
			return entry.event;
		}
		return undefined;
	}

	private keys(keys: OpenClawCacheKeys): string[] {
		return [
			keys.runId ? `run:${keys.runId}` : '',
			keys.sessionKey ? `session:${keys.sessionKey}` : ''
		].filter(Boolean);
	}

	private purge(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key);
		}
	}
}
