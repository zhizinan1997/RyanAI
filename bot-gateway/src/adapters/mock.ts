import { randomBytes } from 'node:crypto';

import type { GatewayConfig } from '../config.js';
import { connectionIdFor, parseMockEvent } from '../event.js';
import type { RyanAiGateway } from '../gateway.js';
import type { GatewayStateStore } from '../state.js';
import type {
	AdapterHealth,
	Channel,
	ConnectionSnapshot,
	DiscoveredGroup,
	GatewayReply,
	MockEventInput,
	QrCodeSnapshot
} from '../types.js';
import { AdapterError, type CreateConnectionInput, type LoginInput, type MockInjectableAdapter } from './types.js';

export class MockAdapter implements MockInjectableAdapter {
	readonly mode = 'mock' as const;
	private started = false;
	private readonly qrCodes = new Map<string, QrCodeSnapshot>();

	constructor(
		private readonly config: GatewayConfig,
		private readonly state: GatewayStateStore,
		private readonly gateway: RyanAiGateway
	) {}

	async start(): Promise<void> {
		for (const channel of this.config.enabledChannels) {
			const id = connectionIdFor(channel);
			if (!(await this.state.getConnection(id))) {
				await this.state.upsertConnection({
					id,
					channel,
					enabled: true,
					status: 'logged_out',
					updatedAt: new Date().toISOString(),
					detail: 'Mock adapter'
				});
			}
		}
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	health(): AdapterHealth {
		return {
			mode: this.mode,
			ready: this.started,
			detail: 'Mock channel adapter; no Tencent network connection'
		};
	}

	async listConnections(): Promise<ConnectionSnapshot[]> {
		return this.state.listConnections();
	}

	async createConnection(input: CreateConnectionInput): Promise<ConnectionSnapshot> {
		if (input.channel !== 'wechat' && input.channel !== 'qq') throw new AdapterError('invalid_channel', 400);
		if (!input.ownerUserId?.trim()) throw new AdapterError('owner_user_id_required', 400);
		const id = input.id || `${input.channel}-${randomBytes(8).toString('base64url')}`;
		if (await this.state.getConnection(id)) throw new AdapterError('connection_already_exists', 409);
		const snapshot: ConnectionSnapshot = {
			id, channel: input.channel, ownerUserId: input.ownerUserId, enabled: input.enabled !== false,
			status: input.enabled === false ? 'disabled' : 'logged_out',
			updatedAt: new Date().toISOString(), detail: 'Mock connection only'
		};
		await this.state.upsertConnection(snapshot);
		return snapshot;
	}

	async deleteConnection(connectionId: string): Promise<void> {
		if (!(await this.state.getConnection(connectionId))) throw new AdapterError('connection_not_found', 404);
		this.qrCodes.delete(connectionId);
		await this.state.deleteConnection(connectionId);
	}

	async login(connectionId: string, _input: LoginInput): Promise<ConnectionSnapshot> {
		const channel = await this.resolveConnection(connectionId);
		const existing = await this.state.getConnection(connectionId);
		if (existing?.enabled === false) throw new AdapterError('connection_disabled', 409);
		const now = Date.now();
		const qrCode: QrCodeSnapshot = {
			connectionId,
			dataUrl: `data:text/plain;base64,${Buffer.from(`MOCK QR ${connectionId}`).toString('base64')}`,
			expiresAt: new Date(now + 5 * 60_000).toISOString(),
			mock: true
		};
		this.qrCodes.set(connectionId, qrCode);
		const snapshot: ConnectionSnapshot = {
			id: connectionId,
			channel,
			enabled: true,
			status: 'connected',
			accountLabel: `mock-${channel}`,
			updatedAt: new Date(now).toISOString(),
			detail: 'Mock connection only'
		};
		await this.state.upsertConnection(snapshot);
		return snapshot;
	}

	async logout(connectionId: string): Promise<ConnectionSnapshot> {
		const channel = await this.resolveConnection(connectionId);
		this.qrCodes.delete(connectionId);
		const snapshot: ConnectionSnapshot = {
			id: connectionId,
			channel,
			enabled: (await this.state.getConnection(connectionId))?.enabled ?? true,
			status: 'logged_out',
			updatedAt: new Date().toISOString(),
			detail: 'Mock adapter'
		};
		await this.state.upsertConnection(snapshot);
		return snapshot;
	}

	async getQrCode(connectionId: string): Promise<QrCodeSnapshot> {
		await this.resolveConnection(connectionId);
		const qrCode = this.qrCodes.get(connectionId);
		if (!qrCode) throw new AdapterError('qr_code_not_available', 404);
		return structuredClone(qrCode);
	}

	async patchConnection(connectionId: string, enabled: boolean): Promise<ConnectionSnapshot> {
		await this.resolveConnection(connectionId);
		const existing = await this.state.getConnection(connectionId);
		if (!existing) throw new AdapterError('connection_not_found', 404);
		const patched = await this.state.patchConnection(connectionId, {
			enabled,
			status: enabled
				? existing.status === 'disabled'
					? 'logged_out'
					: existing.status
				: 'disabled'
		});
		if (!patched) throw new AdapterError('connection_not_found', 404);
		return patched;
	}

	async reconnect(connectionId: string): Promise<ConnectionSnapshot> {
		const credentials = {};
		await this.logout(connectionId);
		return this.login(connectionId, { credentials });
	}

	async discoverGroups(connectionId: string): Promise<DiscoveredGroup[]> {
		await this.resolveConnection(connectionId);
		return this.state.listGroups({ connectionId });
	}

	async inject(input: MockEventInput): Promise<GatewayReply> {
		if (!this.started) throw new AdapterError('adapter_not_started');
		const event = parseMockEvent(input);
		const connection = await this.state.getConnection(event.connectionId);
		if (!connection || !connection.enabled || connection.status !== 'connected') {
			throw new AdapterError('connection_not_connected', 409);
		}
		return this.gateway.handle(event);
	}

	private async resolveConnection(connectionId: string): Promise<Channel> {
		const connection = await this.state.getConnection(connectionId);
		if (connection) return connection.channel;
		throw new AdapterError('connection_not_found', 404);
	}
}
