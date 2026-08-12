import type { GatewayConfig } from './config.js';
import { signRequest } from './security/hmac.js';
import type { CredentialVault } from './security/vault.js';
import type { GatewayStateStore } from './state.js';
import type { Channel, ConnectionSnapshot } from './types.js';

export interface RemoteCheckpoint {
	payload: Buffer;
	sha256: string;
}

interface DesiredConnection {
	id: string;
	channel: Channel;
	owner_user_id?: string | null;
	enabled: boolean;
	status?: string;
	shard_id?: string | null;
	account_key?: string | null;
	assignment_generation?: number;
	credentials_configured: boolean;
}

interface DesiredStateResponse {
	version: '1.0';
	connections: DesiredConnection[];
}

export class GatewayControlPlaneClient {
	constructor(
		private readonly config: GatewayConfig,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	async registerNode(): Promise<void> {
		await this.request('/api/v1/internal/bot-gateway/nodes', 'POST', {
			node_id: this.config.nodeId,
			advertise_url: this.config.advertiseUrl?.toString(),
			capabilities: {
				topology: this.config.openClawTopology,
				channels: [...this.config.enabledChannels],
				shard_capacity: this.config.openClawShardCapacity
			}
		});
	}

	async heartbeat(metrics: Record<string, unknown>): Promise<void> {
		await this.request(
			`/api/v1/internal/bot-gateway/nodes/${encodeURIComponent(this.config.nodeId)}/heartbeat`,
			'POST',
			{
				advertise_url: this.config.advertiseUrl?.toString(),
				metrics
			}
		);
	}

	async syncDesiredState(state: GatewayStateStore): Promise<void> {
		const desired = await this.request<DesiredStateResponse>(
			'/api/v1/internal/bot-gateway/desired-state',
			'GET'
		);
		const existing = new Map((await state.listConnections()).map((item) => [item.id, item]));
		const desiredIds = new Set<string>();
		for (const item of desired.connections) {
			desiredIds.add(item.id);
			const previous = existing.get(item.id);
			const snapshot: ConnectionSnapshot = {
				id: item.id,
				channel: item.channel,
				...(item.owner_user_id ? { ownerUserId: item.owner_user_id } : {}),
				enabled: item.enabled,
				status: item.enabled
					? previous?.status ?? (item.status as ConnectionSnapshot['status']) ?? 'logged_out'
					: 'disabled',
				credentialsConfigured: item.credentials_configured,
				...(item.shard_id ? { shardId: item.shard_id } : {}),
				...(item.account_key ? { accountKey: item.account_key } : {}),
				assignmentGeneration: item.assignment_generation ?? 0,
				updatedAt: new Date().toISOString(),
				...(previous?.detail ? { detail: previous.detail } : {})
			};
			await state.upsertConnection(snapshot);
		}
		for (const item of existing.values()) {
			if (!desiredIds.has(item.id)) await state.deleteConnection(item.id);
		}
	}

	async fetchCredential(connectionId: string, vault: CredentialVault): Promise<Record<string, unknown>> {
		const payload = await this.request<{ version: '1.0'; credentials: Record<string, unknown> }>(
			`/api/v1/internal/bot-gateway/credentials/${encodeURIComponent(connectionId)}`,
			'GET',
			undefined,
			{ 'x-ryanai-node-id': this.config.nodeId }
		);
		await vault.put(connectionId, payload.credentials);
		return payload.credentials;
	}

	async fetchCheckpoint(connectionId: string): Promise<RemoteCheckpoint | undefined> {
		try {
			const result = await this.request<{ payload_base64: string; payload_sha256: string }>(
				`/api/v1/internal/bot-gateway/checkpoints/${encodeURIComponent(connectionId)}`,
				'GET',
				undefined,
				{ 'x-ryanai-node-id': this.config.nodeId }
			);
			return { payload: Buffer.from(result.payload_base64, 'base64'), sha256: result.payload_sha256 };
		} catch (error) {
			if (error instanceof Error && error.message === 'checkpoint_not_found') return undefined;
			throw error;
		}
	}

	async uploadCheckpoint(connectionId: string, checkpoint: RemoteCheckpoint): Promise<void> {
		await this.request(
			`/api/v1/internal/bot-gateway/checkpoints/${encodeURIComponent(connectionId)}`,
			'PUT',
			{ payload_base64: checkpoint.payload.toString('base64'), payload_sha256: checkpoint.sha256 },
			{ 'x-ryanai-node-id': this.config.nodeId }
		);
	}

	private async request<T = unknown>(
		path: string,
		method: 'GET' | 'POST' | 'PUT',
		payload?: Record<string, unknown>,
		extraHeaders: Record<string, string> = {}
	): Promise<T> {
		const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
		const signed = signRequest(this.config.hmacSecret, { method, pathWithQuery: path, body });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(this.config.requestTimeoutMs, 30_000));
		timer.unref();
		try {
			const response = await this.fetchImpl(new URL(path, this.config.ryanAiBaseUrl), {
				method,
				headers: {
					...signed,
					...extraHeaders,
					accept: 'application/json',
					...(payload === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(payload === undefined ? {} : { body: Uint8Array.from(body) }),
				signal: controller.signal
			});
			const raw = await response.text();
			if (!response.ok) {
				let code = `http_${response.status}`;
				try {
					const parsed = JSON.parse(raw) as { detail?: unknown; error?: { code?: unknown } };
					code = String(parsed.detail ?? parsed.error?.code ?? code);
				} catch {}
				throw new Error(code);
			}
			return (raw ? JSON.parse(raw) : {}) as T;
		} finally {
			clearTimeout(timer);
		}
	}
}
