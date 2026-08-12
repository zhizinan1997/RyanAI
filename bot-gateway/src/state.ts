import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { ConnectionSnapshot, DiscoveredGroup, GatewayReply } from './types.js';

import type { ConnectionPatch, ReplayClaim } from './state-common.js';
export type { ConnectionPatch, ReplayClaim };

const STORE_SCHEMA_VERSION = '1';
const STATE_FILE_NAME = 'gateway-state.json';
const STORE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Asynchronous local state store. Every method serializes onto the store's
 * worker thread, so SQLite's synchronous driver can never block the gateway's
 * event loop. SQLite is only a local cache: the RyanAI backend remains the
 * authority for connections, groups and credentials.
 */
export interface GatewayStateStore {
	initialize(): Promise<void>;
	claimEvent(eventId: string, now?: number): Promise<ReplayClaim>;
	completeEvent(
		eventId: string,
		reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>,
		now?: number
	): Promise<void>;
	releaseEvent(eventId: string): Promise<void>;
	upsertConnection(connection: ConnectionSnapshot): Promise<void>;
	deleteConnection(id: string): Promise<boolean>;
	patchConnection(id: string, patch: ConnectionPatch): Promise<ConnectionSnapshot | undefined>;
	listConnections(): Promise<ConnectionSnapshot[]>;
	getConnection(id: string): Promise<ConnectionSnapshot | undefined>;
	upsertGroup(group: DiscoveredGroup): Promise<void>;
	getGroup(channel: string, connectionId: string, groupId: string): Promise<DiscoveredGroup | undefined>;
	patchGroup(
		channel: string,
		connectionId: string,
		groupId: string,
		patch: Pick<Partial<DiscoveredGroup>, 'enabled' | 'name'>
	): Promise<DiscoveredGroup | undefined>;
	listGroups(filters?: { channel?: string; connectionId?: string }): Promise<DiscoveredGroup[]>;
	/** Opaque JSON value per well-known key (circuit state, backoff budgets...). */
	setRuntimeState(key: string, value: unknown): Promise<void>;
	getRuntimeState<T = unknown>(key: string): Promise<T | undefined>;
	deleteRuntimeState(key: string): Promise<void>;
	close(): Promise<void>;
}

interface StoreMessage {
	requestId: number;
	ok: boolean;
	value?: unknown;
	error?: string;
}

class StoreConnectionError extends Error {
	override name = 'StoreConnectionError';
}

function storeError(message: string): StoreConnectionError {
	return new StoreConnectionError(message);
}

export class GatewayStateStore {
	private readonly dbPath: string;
	private readonly stateFilePath: string;
	private worker: Worker | undefined;
	private purgeTimer: NodeJS.Timeout | undefined;
	private requestId = 0;
	private readonly pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (reason: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	private closed = false;

	constructor(
		dataDir: string,
		private readonly replayTtlMs: number
	) {
		const stateDir = path.join(dataDir, 'state');
		this.stateFilePath = path.join(stateDir, STATE_FILE_NAME);
		this.dbPath = path.join(stateDir, 'gateway-state.db');
	}

	async initialize(): Promise<void> {
		await mkdir(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
		this.worker = new Worker(workerEntryUrl(), {
			workerData: {
				dbPath: this.dbPath,
				schemaVersion: STORE_SCHEMA_VERSION,
				replayTtlMs: this.replayTtlMs
			}
		});
		// Explicit close remains the production ownership contract. Unref only
		// prevents short-lived tooling from being held open by an idle worker.
		this.worker.unref();
		this.worker.on('message', (message: StoreMessage) => this.settle(message));
		this.worker.on('error', (error) => this.failAll(error));
		this.worker.on('exit', (code) => {
			if (!this.closed && code !== 0) {
				this.failAll(storeError(`State store worker exited unexpectedly (${code})`));
			}
		});
		await this.send('open');
		await this.migrateLegacyJson();
		await this.send('purgeExpired', { now: Date.now() });
		this.purgeTimer = setInterval(() => {
			void this.send('purgeExpired', { now: Date.now() }).catch(() => undefined);
		}, 60_000);
		this.purgeTimer.unref();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (this.purgeTimer) clearInterval(this.purgeTimer);
		this.purgeTimer = undefined;
		const worker = this.worker;
		if (!worker) {
			this.closed = true;
			return;
		}
		try {
			await this.send('close');
		} finally {
			this.closed = true;
			this.worker = undefined;
		}
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(storeError('State store is closed'));
		}
		this.pending.clear();
		await worker.terminate().catch(() => undefined);
	}

	async claimEvent(eventId: string, now = Date.now()): Promise<ReplayClaim> {
		return (await this.send('claimEvent', { eventId, now })) as ReplayClaim;
	}

	async completeEvent(
		eventId: string,
		reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>,
		now = Date.now()
	): Promise<void> {
		await this.send('completeEvent', { eventId, reply, now });
	}

	async releaseEvent(eventId: string): Promise<void> {
		await this.send('releaseEvent', { eventId });
	}

	async upsertConnection(connection: ConnectionSnapshot): Promise<void> {
		await this.send('upsertConnection', { connection });
	}

	async deleteConnection(id: string): Promise<boolean> {
		return (await this.send('deleteConnection', { id })) as boolean;
	}

	async patchConnection(id: string, patch: ConnectionPatch): Promise<ConnectionSnapshot | undefined> {
		return (await this.send('patchConnection', { id, patch })) as ConnectionSnapshot | undefined;
	}

	async listConnections(): Promise<ConnectionSnapshot[]> {
		return (await this.send('listConnections')) as ConnectionSnapshot[];
	}

	async getConnection(id: string): Promise<ConnectionSnapshot | undefined> {
		return (await this.send('getConnection', { id })) as ConnectionSnapshot | undefined;
	}

	async upsertGroup(group: DiscoveredGroup): Promise<void> {
		await this.send('upsertGroup', { group });
	}

	async getGroup(channel: string, connectionId: string, groupId: string): Promise<DiscoveredGroup | undefined> {
		return (await this.send('getGroup', { channel, connectionId, groupId })) as
			| DiscoveredGroup
			| undefined;
	}

	async patchGroup(
		channel: string,
		connectionId: string,
		groupId: string,
		patch: Pick<Partial<DiscoveredGroup>, 'enabled' | 'name'>
	): Promise<DiscoveredGroup | undefined> {
		return (await this.send('patchGroup', { channel, connectionId, groupId, patch })) as
			| DiscoveredGroup
			| undefined;
	}

	async listGroups(filters: { channel?: string; connectionId?: string } = {}): Promise<DiscoveredGroup[]> {
		return (await this.send('listGroups', { filters })) as DiscoveredGroup[];
	}

	async setRuntimeState(key: string, value: unknown): Promise<void> {
		await this.send('setRuntimeState', { key, value });
	}

	async getRuntimeState<T = unknown>(key: string): Promise<T | undefined> {
		return (await this.send('getRuntimeState', { key })) as T | undefined;
	}

	async deleteRuntimeState(key: string): Promise<void> {
		await this.send('deleteRuntimeState', { key });
	}

	private async migrateLegacyJson(): Promise<void> {
		if (!existsSync(this.stateFilePath)) return;
		let raw: Buffer;
		let parsed: PersistedState;
		try {
			raw = await readFile(this.stateFilePath);
			parsed = JSON.parse(raw.toString('utf8')) as PersistedState;
			if (parsed.version !== 1) throw new Error(`Unsupported gateway state version: ${parsed.version}`);
		} catch (error) {
			throw new Error(
				`Gateway state migration aborted; legacy file kept in place: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
		const checksum = createHash('sha256').update(raw).digest('hex');
		const sourceCounts = {
			replays: Object.keys(parsed.replays ?? {}).length,
			connections: Object.keys(parsed.connections ?? {}).length,
			groups: Object.keys(parsed.groups ?? {}).length
		};
		await this.send('importJsonState', {
			replays: parsed.replays ?? {},
			connections: parsed.connections ?? {},
			groups: parsed.groups ?? {},
			sourceCounts,
			checksum
		});
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = `${this.stateFilePath}.${stamp}.${checksum}.bak`;
		await rename(this.stateFilePath, backupPath);
	}

	private send(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		if (this.closed || !this.worker) return Promise.reject(storeError('State store is not open'));
		const id = ++this.requestId;
		this.worker.ref();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				if (this.pending.size === 0) this.worker?.unref();
				reject(storeError(`State store operation timed out: ${kind}`));
			}, STORE_REQUEST_TIMEOUT_MS);
			timer.unref();
			this.pending.set(id, { resolve, reject, timer });
			this.worker!.postMessage({ requestId: id, kind, ...payload });
		});
	}

	private settle(message: StoreMessage): void {
		const entry = this.pending.get(message.requestId);
		if (!entry) return;
		this.pending.delete(message.requestId);
		clearTimeout(entry.timer);
		if (this.pending.size === 0) this.worker?.unref();
		if (message.ok) entry.resolve(message.value);
		else entry.reject(storeError(message.error || 'State store operation failed'));
	}

	private failAll(error: Error): void {
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		this.pending.clear();
		this.worker = undefined;
	}
}

interface PersistedState {
	version: number;
	replays?: Record<string, { state: string; expiresAt: number; reply?: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'> }>;
	connections?: Record<string, ConnectionSnapshot>;
	groups?: Record<string, DiscoveredGroup>;
}

function workerEntryUrl(): URL {
	// The worker runs next to this module in both the compiled `dist`/`.test-dist`
	// trees and the tsx dev loader, so resolve the sibling with a matching extension.
	const current = fileURLToPath(import.meta.url);
	const extension = current.endsWith('.ts') ? 'ts' : 'js';
	return pathToFileURL(path.join(path.dirname(current), `state-worker.${extension}`));
}
