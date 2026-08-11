import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ConnectionSnapshot, DiscoveredGroup, GatewayReply } from './types.js';

interface ReplayRecord {
	state: 'processing' | 'completed';
	expiresAt: number;
	reply?: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>;
}

interface PersistedState {
	version: 1;
	replays: Record<string, ReplayRecord>;
	connections: Record<string, ConnectionSnapshot>;
	groups: Record<string, DiscoveredGroup>;
}

const EMPTY_STATE: PersistedState = {
	version: 1,
	replays: {},
	connections: {},
	groups: {}
};

const PROCESSING_LEASE_MS = 15 * 60 * 1000;

export type ReplayClaim =
	| { status: 'new' }
	| { status: 'processing' }
	| { status: 'completed'; reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'> };

export class GatewayStateStore {
	private readonly filePath: string;
	private state: PersistedState = structuredClone(EMPTY_STATE);
	private tail: Promise<void> = Promise.resolve();

	constructor(
		dataDir: string,
		private readonly replayTtlMs: number
	) {
		this.filePath = path.join(dataDir, 'state', 'gateway-state.json');
	}

	async initialize(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		try {
			const raw = await readFile(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as PersistedState;
			if (parsed.version !== 1) throw new Error('Unsupported gateway state version');
			this.state = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			await this.persist();
		}
		await this.mutate(() => this.purgeExpired(Date.now()));
	}

	async claimEvent(eventId: string, now = Date.now()): Promise<ReplayClaim> {
		let result: ReplayClaim = { status: 'new' };
		await this.mutate(() => {
			this.purgeExpired(now);
			const record = this.state.replays[eventId];
			if (record?.state === 'completed' && record.reply) {
				result = { status: 'completed', reply: structuredClone(record.reply) };
				return false;
			}
			if (record?.state === 'processing') {
				result = { status: 'processing' };
				return false;
			}
			this.state.replays[eventId] = {
				state: 'processing',
				expiresAt: now + Math.min(this.replayTtlMs, PROCESSING_LEASE_MS)
			};
			return true;
		});
		return result;
	}

	async completeEvent(
		eventId: string,
		reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>,
		now = Date.now()
	): Promise<void> {
		await this.mutate(() => {
			this.state.replays[eventId] = {
				state: 'completed',
				expiresAt: now + this.replayTtlMs,
				reply: structuredClone(reply)
			};
			return true;
		});
	}

	async releaseEvent(eventId: string): Promise<void> {
		await this.mutate(() => {
			const existing = this.state.replays[eventId];
			if (!existing || existing.state !== 'processing') return false;
			delete this.state.replays[eventId];
			return true;
		});
	}

	async upsertConnection(connection: ConnectionSnapshot): Promise<void> {
		await this.mutate(() => {
			this.state.connections[connection.id] = structuredClone(connection);
			return true;
		});
	}

	async deleteConnection(id: string): Promise<boolean> {
		let deleted = false;
		await this.mutate(() => {
			if (!this.state.connections[id]) return false;
			delete this.state.connections[id];
			for (const key of Object.keys(this.state.groups)) {
				if (key.split('\u0000')[1] === id) delete this.state.groups[key];
			}
			for (const key of Object.keys(this.state.replays)) {
				if (key.split('\u0000')[1] === id) delete this.state.replays[key];
			}
			deleted = true;
			return true;
		});
		return deleted;
	}

	async patchConnection(
		id: string,
		patch: Partial<
			Pick<
				ConnectionSnapshot,
				'enabled' | 'status' | 'detail' | 'accountLabel' | 'trustedOwnerExternalId'
			>
		>
	): Promise<ConnectionSnapshot | undefined> {
		let result: ConnectionSnapshot | undefined;
		await this.mutate(() => {
			const existing = this.state.connections[id];
			if (!existing) return false;
			result = {
				...existing,
				...patch,
				updatedAt: new Date().toISOString()
			};
			this.state.connections[id] = result;
			return true;
		});
		return result ? structuredClone(result) : undefined;
	}

	listConnections(): ConnectionSnapshot[] {
		return Object.values(this.state.connections)
			.map((entry) => structuredClone(entry))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	getConnection(id: string): ConnectionSnapshot | undefined {
		const value = this.state.connections[id];
		return value ? structuredClone(value) : undefined;
	}

	async upsertGroup(group: DiscoveredGroup): Promise<void> {
		const key = `${group.channel}\u0000${group.connectionId}\u0000${group.groupId}`;
		await this.mutate(() => {
			const existing = this.state.groups[key];
			this.state.groups[key] = {
				...structuredClone(group),
				enabled: existing?.enabled ?? group.enabled
			};
			return true;
		});
	}

	getGroup(channel: string, connectionId: string, groupId: string): DiscoveredGroup | undefined {
		const value = this.state.groups[`${channel}\u0000${connectionId}\u0000${groupId}`];
		return value ? structuredClone(value) : undefined;
	}

	async patchGroup(
		channel: string,
		connectionId: string,
		groupId: string,
		patch: Pick<Partial<DiscoveredGroup>, 'enabled' | 'name'>
	): Promise<DiscoveredGroup | undefined> {
		const key = `${channel}\u0000${connectionId}\u0000${groupId}`;
		let result: DiscoveredGroup | undefined;
		await this.mutate(() => {
			const existing = this.state.groups[key];
			if (!existing) return false;
			result = { ...existing, ...patch };
			this.state.groups[key] = result;
			return true;
		});
		return result ? structuredClone(result) : undefined;
	}

	listGroups(filters: { channel?: string; connectionId?: string } = {}): DiscoveredGroup[] {
		return Object.values(this.state.groups)
			.filter((group) => !filters.channel || group.channel === filters.channel)
			.filter((group) => !filters.connectionId || group.connectionId === filters.connectionId)
			.map((entry) => structuredClone(entry))
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
	}

	private purgeExpired(now: number): boolean {
		let changed = false;
		for (const [eventId, record] of Object.entries(this.state.replays)) {
			if (record.expiresAt <= now) {
				delete this.state.replays[eventId];
				changed = true;
			}
		}
		return changed;
	}

	private async mutate(action: () => boolean): Promise<void> {
		const operation = this.tail.then(async () => {
			if (action()) await this.persist();
		});
		this.tail = operation.catch(() => undefined);
		return operation;
	}

	private async persist(): Promise<void> {
		const tempPath = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(tempPath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
		try {
			await rename(tempPath, this.filePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM') throw error;
			await copyFile(tempPath, this.filePath);
			await unlink(tempPath);
		}
	}
}
