import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import {
	boolToInt,
	EMPTY_CONNECTION_COLUMNS,
	escapeLike,
	nullable,
	parseReplyJson,
	rowToConnection,
	rowToGroup,
	stringifyReply,
	type ConnectionPatch,
	type ReplayClaim
} from './state-common.js';
import type { ConnectionSnapshot, DiscoveredGroup, GatewayReply } from './types.js';

const db = new DatabaseSync(workerData.dbPath as string);
const replayTtlMs = Number((workerData.replayTtlMs as number) || 24 * 60 * 60 * 1_000);
const PROCESSING_LEASE_MS = 15 * 60 * 1000;

db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');
db.exec('PRAGMA foreign_keys=ON');
db.exec('PRAGMA busy_timeout=5000');
db.exec(`
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
	id TEXT PRIMARY KEY,
	channel TEXT NOT NULL,
	owner_user_id TEXT,
	enabled INTEGER NOT NULL,
	status TEXT NOT NULL,
	detail TEXT,
	account_label TEXT,
	trusted_owner_external_id TEXT,
	shard_id TEXT,
	account_key TEXT,
	assignment_generation INTEGER NOT NULL DEFAULT 0,
	credentials_configured INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
	channel TEXT NOT NULL,
	connection_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	enabled INTEGER NOT NULL,
	name TEXT,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (channel, connection_id, group_id)
);
CREATE TABLE IF NOT EXISTS replays (
	event_id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
	expires_at INTEGER NOT NULL,
	reply_json TEXT
);
CREATE TABLE IF NOT EXISTS runtime_state (
	key TEXT PRIMARY KEY,
	json TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_replays_expires_at ON replays (expires_at);
CREATE INDEX IF NOT EXISTS ix_groups_connection ON groups (connection_id);
`);
const connectionColumns = new Set(
	(db.prepare("PRAGMA table_info('connections')").all() as Array<{ name: string }>).map((row) => row.name)
);
if (!connectionColumns.has('assignment_generation')) {
	db.exec('ALTER TABLE connections ADD COLUMN assignment_generation INTEGER NOT NULL DEFAULT 0');
}
if (!connectionColumns.has('credentials_configured')) {
	db.exec('ALTER TABLE connections ADD COLUMN credentials_configured INTEGER NOT NULL DEFAULT 0');
}
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
	workerData.schemaVersion as string
);

const insertConnection = db.prepare(`
	INSERT INTO connections (${EMPTY_CONNECTION_COLUMNS})
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (id) DO UPDATE SET
		channel = excluded.channel,
		owner_user_id = excluded.owner_user_id,
		enabled = excluded.enabled,
		status = excluded.status,
		detail = excluded.detail,
		account_label = excluded.account_label,
		trusted_owner_external_id = excluded.trusted_owner_external_id,
		shard_id = excluded.shard_id,
		account_key = excluded.account_key,
		assignment_generation = excluded.assignment_generation,
		credentials_configured = excluded.credentials_configured,
		updated_at = excluded.updated_at
`);
const getConnectionStmt = db.prepare(`SELECT ${EMPTY_CONNECTION_COLUMNS} FROM connections WHERE id = ?`);
const listConnectionsStmt = db.prepare(`SELECT ${EMPTY_CONNECTION_COLUMNS} FROM connections ORDER BY id`);
const listGroupsStmt = db.prepare('SELECT * FROM groups ORDER BY last_seen_at DESC');
const listGroupsFilteredStmt = db.prepare(
	'SELECT * FROM groups WHERE channel = ?1 AND connection_id = ?2 ORDER BY last_seen_at DESC'
);
const getGroupStmt = db.prepare(
	'SELECT * FROM groups WHERE channel = ? AND connection_id = ? AND group_id = ?'
);
const deleteConnectionStmt = db.prepare('DELETE FROM connections WHERE id = ?');
const deleteGroupsForConnection = db.prepare('DELETE FROM groups WHERE connection_id = ?');
const deleteReplaysForConnection = db.prepare(
	"DELETE FROM replays WHERE event_id LIKE ? ESCAPE '\\' OR event_id LIKE ? ESCAPE '\\'"
);
const getReplay = db.prepare('SELECT event_id, state, expires_at, reply_json FROM replays WHERE event_id = ?');
const insertReplay = db.prepare(
	'INSERT INTO replays (event_id, state, expires_at, reply_json) VALUES (?, ?, ?, ?)'
);
const upsertReplay = db.prepare(`
	INSERT INTO replays (event_id, state, expires_at, reply_json) VALUES (?, ?, ?, ?)
	ON CONFLICT (event_id) DO UPDATE SET
		state = excluded.state,
		expires_at = excluded.expires_at,
		reply_json = excluded.reply_json
`);
const updateReplay = db.prepare(
	'UPDATE replays SET state = ?, expires_at = ?, reply_json = ? WHERE event_id = ?'
);
const deleteReplay = db.prepare('DELETE FROM replays WHERE event_id = ?');
const purgeExpiredStmt = db.prepare('DELETE FROM replays WHERE expires_at <= ?');
const runtimeStateByKey = db.prepare('SELECT json FROM runtime_state WHERE key = ?');
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const putMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
const upsertRuntimeState = db.prepare(`
	INSERT INTO runtime_state (key, json, updated_at) VALUES (?, ?, ?)
	ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
`);
const deleteRuntimeStateStmt = db.prepare('DELETE FROM runtime_state WHERE key = ?');

function transaction<T>(operation: () => T): T {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = operation();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

interface InboundMessage {
	requestId: number;
	kind: string;
	[key: string]: unknown;
}

const handlers: Record<string, (message: InboundMessage) => unknown> = {
	open() {
		return true;
	},
	purgeExpired(message) {
		return transaction(() => {
			const changed = purgeExpiredStmt.run(message.now as number).changes > 0;
			return changed;
		});
	},
	claimEvent(message) {
		const { eventId, now } = message as unknown as { eventId: string; now: number };
		return transaction((): ReplayClaim => {
			purgeExpiredStmt.run(now);
			const record = getReplay.get(eventId) as Record<string, unknown> | undefined;
			if (record?.state === 'completed') {
				const reply = parseReplyJson(record.reply_json as string | null);
				// A completed record whose reply cannot be decoded is treated like a
				// fresh claim: the request is retried and the record is overwritten,
				// matching the sidecar store's semantics for unrecoverable rows.
				if (reply) return { status: 'completed', reply };
			} else if (record?.state === 'processing') {
				return { status: 'processing' };
			}
			upsertReplay.run(
				eventId,
				'processing',
				now + Math.min(replayTtlMs, PROCESSING_LEASE_MS),
				null
			);
			return { status: 'new' };
		});
	},
	completeEvent(message) {
		const { eventId, reply, now } = message as unknown as {
			eventId: string;
			reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>;
			now: number;
		};
		return transaction(() => {
			updateReplay.run('completed', now + replayTtlMs, stringifyReply(reply), eventId);
		});
	},
	releaseEvent(message) {
		const { eventId } = message as unknown as { eventId: string };
		return transaction(() => {
			const record = getReplay.get(eventId) as Record<string, unknown> | undefined;
			if (!record || record.state !== 'processing') return false;
			deleteReplay.run(eventId);
			return true;
		});
	},
	upsertConnection(message) {
		const connection = message.connection as ConnectionSnapshot;
		insertConnection.run(
			connection.id,
			connection.channel,
			nullable(connection.ownerUserId),
			boolToInt(connection.enabled),
			connection.status,
			nullable(connection.detail),
			nullable(connection.accountLabel),
			nullable(connection.trustedOwnerExternalId),
			nullable(connection.shardId),
				nullable(connection.accountKey),
				connection.assignmentGeneration ?? 0,
				boolToInt(connection.credentialsConfigured ?? false),
				connection.updatedAt
		);
	},
	deleteConnection(message) {
		const { id } = message as unknown as { id: string };
		return transaction(() => {
			if (deleteConnectionStmt.run(id).changes === 0) return false;
			deleteGroupsForConnection.run(id);
			// The event key embeds the connection id between two NUL separators,
			// so match the exact `channel\0id\0` prefix rather than a bare substring.
			const wechatPrefix = `wechat\u0000${escapeLike(id)}\u0000`;
			const qqPrefix = `qq\u0000${escapeLike(id)}\u0000`;
			deleteReplaysForConnection.run(`${wechatPrefix}%`, `${qqPrefix}%`);
			return true;
		});
	},
	patchConnection(message) {
		const { id, patch } = message as unknown as { id: string; patch: ConnectionPatch };
		return transaction(() => {
			const row = getConnectionStmt.get(id) as Record<string, unknown> | undefined;
			if (!row) return undefined;
			const current = rowToConnection(row);
			const next: ConnectionSnapshot = { ...current, ...patch, updatedAt: new Date().toISOString() };
			insertConnection.run(
				next.id,
				next.channel,
				nullable(next.ownerUserId),
				boolToInt(next.enabled),
				next.status,
				nullable(next.detail),
				nullable(next.accountLabel),
				nullable(next.trustedOwnerExternalId),
				nullable(next.shardId),
					nullable(next.accountKey),
					next.assignmentGeneration ?? 0,
					boolToInt(next.credentialsConfigured ?? false),
					next.updatedAt
			);
			return next;
		});
	},
	listConnections() {
		return (listConnectionsStmt.all() as Record<string, unknown>[]).map(rowToConnection);
	},
	getConnection(message) {
		const row = getConnectionStmt.get((message as unknown as { id: string }).id) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToConnection(row) : undefined;
	},
	upsertGroup(message) {
		const group = message.group as DiscoveredGroup;
		const existing = getGroupStmt.get(group.channel, group.connectionId, group.groupId) as
			| Record<string, unknown>
			| undefined;
		const enabled = existing ? (existing.enabled === 1 || existing.enabled === true) : group.enabled;
		db.prepare(`
			INSERT INTO groups (channel, connection_id, group_id, enabled, name, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (channel, connection_id, group_id) DO UPDATE SET
				enabled = ?,
				name = excluded.name,
				last_seen_at = excluded.last_seen_at
		`).run(
			group.channel,
			group.connectionId,
			group.groupId,
			boolToInt(enabled),
			nullable(group.name),
			group.lastSeenAt,
			boolToInt(enabled)
		);
	},
	getGroup(message) {
		const { channel, connectionId, groupId } = message as unknown as {
			channel: string;
			connectionId: string;
			groupId: string;
		};
		const row = getGroupStmt.get(channel, connectionId, groupId) as Record<string, unknown> | undefined;
		return row ? rowToGroup(row) : undefined;
	},
	patchGroup(message) {
		const { channel, connectionId, groupId, patch } = message as unknown as {
			channel: string;
			connectionId: string;
			groupId: string;
			patch: { enabled?: boolean; name?: string };
		};
		return transaction(() => {
			const row = getGroupStmt.get(channel, connectionId, groupId) as Record<string, unknown> | undefined;
			if (!row) return undefined;
			const next = { ...rowToGroup(row), ...patch };
			db.prepare(
				'UPDATE groups SET enabled = ?, name = ? WHERE channel = ? AND connection_id = ? AND group_id = ?'
			).run(boolToInt(next.enabled), nullable(next.name), channel, connectionId, groupId);
			return next;
		});
	},
	listGroups(message) {
		const filters = (message.filters ?? {}) as { channel?: string; connectionId?: string };
		if (filters.channel && filters.connectionId) {
			return (listGroupsFilteredStmt.all(filters.channel, filters.connectionId) as Record<string, unknown>[]).map(
				rowToGroup
			);
		}
		if (filters.channel) {
			return (
				db
					.prepare('SELECT * FROM groups WHERE channel = ? ORDER BY last_seen_at DESC')
					.all(filters.channel) as Record<string, unknown>[]
			).map(rowToGroup);
		}
		if (filters.connectionId) {
			return (
				db
					.prepare('SELECT * FROM groups WHERE connection_id = ? ORDER BY last_seen_at DESC')
					.all(filters.connectionId) as Record<string, unknown>[]
			).map(rowToGroup);
		}
		return (listGroupsStmt.all() as Record<string, unknown>[]).map(rowToGroup);
	},
	setRuntimeState(message) {
		const { key, value } = message as unknown as { key: string; value: unknown };
		upsertRuntimeState.run(key, JSON.stringify(value ?? null), Date.now());
	},
	getRuntimeState(message) {
		const row = runtimeStateByKey.get((message as unknown as { key: string }).key) as
			| Record<string, unknown>
			| undefined;
		if (!row) return undefined;
		try {
			const parsed: unknown = JSON.parse(String(row.json));
			return parsed === null ? undefined : parsed;
		} catch {
			return undefined;
		}
	},
	deleteRuntimeState(message) {
		deleteRuntimeStateStmt.run((message as unknown as { key: string }).key);
	},
	importJsonState(message) {
		const { replays, connections, groups, sourceCounts, checksum } = message as unknown as {
			replays: Record<string, { state: string; expiresAt: number; reply?: unknown }>;
			connections: Record<string, ConnectionSnapshot>;
			groups: Record<string, DiscoveredGroup>;
			sourceCounts: { replays: number; connections: number; groups: number };
			checksum: string;
		};
		return transaction(() => {
			// A previous run may already have imported this exact file before its
			// rename was interrupted; the receipt makes the migration idempotent.
			const previous = getMeta.get('migrated_json_checksum') as Record<string, unknown> | undefined;
			if (previous && String(previous.value) === checksum) return true;
				if (previous) {
				throw new Error(
					'Gateway state file checksum differs from the recorded migration receipt'
				);
				}
				const existingCounts = {
					replays: (db.prepare('SELECT COUNT(*) AS n FROM replays').get() as { n: number }).n,
					connections: (db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n,
					groups: (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n
				};
				if (existingCounts.replays || existingCounts.connections || existingCounts.groups) {
					throw new Error('Gateway state JSON can only be imported into an empty SQLite store');
				}
			for (const connection of Object.values(connections)) {
				insertConnection.run(
					connection.id,
					connection.channel,
					nullable(connection.ownerUserId),
					boolToInt(connection.enabled),
					connection.status,
					nullable(connection.detail),
					nullable(connection.accountLabel),
					nullable(connection.trustedOwnerExternalId),
					nullable(connection.shardId),
						nullable(connection.accountKey),
						connection.assignmentGeneration ?? 0,
						boolToInt(connection.credentialsConfigured ?? false),
						connection.updatedAt
				);
			}
			for (const group of Object.values(groups)) {
				db.prepare(
					'INSERT OR IGNORE INTO groups (channel, connection_id, group_id, enabled, name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
				).run(
					group.channel,
					group.connectionId,
					group.groupId,
					boolToInt(group.enabled),
					nullable(group.name),
					group.lastSeenAt
				);
			}
			for (const [eventId, record] of Object.entries(replays)) {
				insertReplay.run(
					eventId,
					record.state === 'completed' ? 'completed' : 'processing',
					record.expiresAt,
					'reply' in record && record.reply !== undefined
						? stringifyReply(
								record.reply as Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>
							)
						: null
				);
			}
			const counts = {
				replays: db.prepare('SELECT COUNT(*) AS n FROM replays').get() as { n: number },
				connections: db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number },
				groups: db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }
			};
			if (
				counts.replays.n !== sourceCounts.replays ||
				counts.connections.n !== sourceCounts.connections ||
				counts.groups.n !== sourceCounts.groups
			) {
				throw new Error(
					`Gateway state row count mismatch: replays ${counts.replays.n}/${sourceCounts.replays}, ` +
						`connections ${counts.connections.n}/${sourceCounts.connections}, ` +
						`groups ${counts.groups.n}/${sourceCounts.groups}`
				);
			}
			putMeta.run('migrated_json_checksum', checksum);
			putMeta.run('migrated_json_rows', JSON.stringify(sourceCounts));
		});
	},
	close() {
		db.close();
		return true;
	}
};

parentPort!.on('message', (message: InboundMessage) => {
	let value: unknown;
	try {
		const handler = handlers[message.kind];
		if (!handler) throw new Error(`Unknown state store operation: ${message.kind}`);
		value = handler(message);
	} catch (error) {
		parentPort!.postMessage({
			requestId: message.requestId,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
		return;
	}
	parentPort!.postMessage({ requestId: message.requestId, ok: true, value });
	if (message.kind === 'close') parentPort!.close();
});
