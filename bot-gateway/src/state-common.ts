import type { ConnectionSnapshot, DiscoveredGroup, GatewayReply } from './types.js';

export type ReplayClaim =
	| { status: 'new' }
	| { status: 'processing' }
	| { status: 'completed'; reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'> };

export type ConnectionPatch = Partial<
	Pick<
		ConnectionSnapshot,
		| 'enabled'
		| 'status'
		| 'detail'
		| 'accountLabel'
		| 'trustedOwnerExternalId'
		| 'shardId'
		| 'accountKey'
		| 'assignmentGeneration'
		| 'credentialsConfigured'
	>
>;

export const EMPTY_CONNECTION_COLUMNS =
	'id, channel, owner_user_id, enabled, status, detail, account_label, trusted_owner_external_id, shard_id, account_key, assignment_generation, credentials_configured, updated_at';

export function rowToConnection(row: Record<string, unknown>): ConnectionSnapshot {
	const result: ConnectionSnapshot = {
		id: String(row.id),
		channel: String(row.channel) as ConnectionSnapshot['channel'],
		enabled: row.enabled === 1 || row.enabled === true,
		status: String(row.status) as ConnectionSnapshot['status'],
		updatedAt: String(row.updated_at)
	};
	if (row.owner_user_id !== null && row.owner_user_id !== undefined) {
		result.ownerUserId = String(row.owner_user_id);
	}
	if (row.detail !== null && row.detail !== undefined) result.detail = String(row.detail);
	if (row.account_label !== null && row.account_label !== undefined) {
		result.accountLabel = String(row.account_label);
	}
	if (row.trusted_owner_external_id !== null && row.trusted_owner_external_id !== undefined) {
		result.trustedOwnerExternalId = String(row.trusted_owner_external_id);
	}
	if (row.shard_id !== null && row.shard_id !== undefined) result.shardId = String(row.shard_id);
	if (row.account_key !== null && row.account_key !== undefined) {
		result.accountKey = String(row.account_key);
	}
	if (row.assignment_generation !== null && row.assignment_generation !== undefined) {
		result.assignmentGeneration = Number(row.assignment_generation);
	}
	result.credentialsConfigured =
		row.credentials_configured === 1 || row.credentials_configured === true;
	return result;
}

export function rowToGroup(row: Record<string, unknown>): DiscoveredGroup {
	const group: DiscoveredGroup = {
		channel: String(row.channel) as DiscoveredGroup['channel'],
		connectionId: String(row.connection_id),
		groupId: String(row.group_id),
		enabled: row.enabled === 1 || row.enabled === true,
		lastSeenAt: String(row.last_seen_at)
	};
	if (row.name !== null && row.name !== undefined) group.name = String(row.name);
	return group;
}

export function nullable(value: unknown): string | null {
	return value === undefined || value === null || value === '' ? null : String(value);
}

export function boolToInt(value: boolean): number {
	return value ? 1 : 0;
}

export function parseReplyJson(
	raw: string | null
): Pick<GatewayReply, 'chunks' | 'isError' | 'reason'> | undefined {
	if (raw === null || raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as { chunks?: unknown; isError?: unknown; reason?: unknown };
		if (!Array.isArray(parsed.chunks) || typeof parsed.isError !== 'boolean') return undefined;
		return {
			chunks: parsed.chunks.filter((chunk): chunk is string => typeof chunk === 'string'),
			isError: parsed.isError,
			reason: parsed.reason as Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>['reason']
		};
	} catch {
		return undefined;
	}
}

export function stringifyReply(
	reply: Pick<GatewayReply, 'chunks' | 'isError' | 'reason'>
): string {
	return JSON.stringify({ chunks: reply.chunks, isError: reply.isError, reason: reply.reason });
}

/** Escape LIKE wildcards so connection-id patterns match literal text only. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
