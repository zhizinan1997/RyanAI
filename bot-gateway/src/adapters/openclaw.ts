import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { GatewayConfig } from '../config.js';
import { Logger, safeErrorFields } from '../logger.js';
import {
	OpenClawHost,
	type OpenClawAccountStatus,
	type OpenClawCredentialSet
} from '../openclaw/host.js';
import {
	startQqOfficialLogin,
	startWeixinOfficialLogin,
	type PendingOfficialLogin,
	type QqLoginCredential,
	type WeixinLoginCredential
} from '../openclaw/official-login.js';
import type { CredentialVault } from '../security/vault.js';
import type { GatewayStateStore } from '../state.js';
import type {
	AdapterHealth,
	Channel,
	ConnectionSnapshot,
	ConnectionStatus,
	DiscoveredGroup,
	QrCodeSnapshot
} from '../types.js';
import {
	AdapterError,
	type ChannelAdapter,
	type CreateConnectionInput,
	type LoginInput
} from './types.js';

interface OpenClawHostController {
	isRunning(): boolean;
	healthDetail(): string;
	start(credentials: OpenClawCredentialSet, channelEnabled: Record<Channel, boolean>): Promise<void>;
	stop(): Promise<void>;
	clearCredentials?(): Promise<void>;
	restart(credentials?: OpenClawCredentialSet, channelEnabled?: Record<Channel, boolean>): Promise<void>;
	status(channel: Channel): Promise<OpenClawAccountStatus>;
}

type OfficialLogin =
	| PendingOfficialLogin<WeixinLoginCredential>
	| PendingOfficialLogin<QqLoginCredential>;

export interface OpenClawAdapterDependencies {
	host?: OpenClawHostController;
	startWeixinLogin?: typeof startWeixinOfficialLogin;
	startQqLogin?: typeof startQqOfficialLogin;
}

function text(value: Record<string, unknown>, keys: readonly string[], max: number): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, max);
	}
	return undefined;
}

function parseWeixinCredential(value?: Record<string, unknown>): WeixinLoginCredential | undefined {
	if (!value) return undefined;
	const accountId = text(value, ['accountId', 'account_id'], 512);
	const botToken = text(value, ['botToken', 'bot_token'], 16_384);
	if (!accountId || !botToken) return undefined;
	const baseUrl = text(value, ['baseUrl', 'base_url'], 2_048);
	const userId = text(value, ['userId', 'user_id'], 512);
	return { accountId, botToken, ...(baseUrl ? { baseUrl } : {}), ...(userId ? { userId } : {}) };
}

function parseQqCredential(value?: Record<string, unknown>): QqLoginCredential | undefined {
	if (!value) return undefined;
	const appId = text(value, ['appId', 'app_id'], 512);
	const appSecret = text(value, ['appSecret', 'app_secret'], 4_096);
	if (!appId || !appSecret) return undefined;
	const userOpenid = text(value, ['userOpenid', 'user_openid'], 512);
	return { appId, appSecret, ...(userOpenid ? { userOpenid } : {}) };
}

type Credential = WeixinLoginCredential | QqLoginCredential;

function sameCredential(left: Credential | undefined, right: Credential): boolean {
	if (!left) return false;
	if ('appId' in left && 'appId' in right) {
		return (
			left.appId === right.appId &&
			left.appSecret === right.appSecret &&
			left.userOpenid === right.userOpenid
		);
	}
	if ('accountId' in left && 'accountId' in right) {
		return (
			left.accountId === right.accountId &&
			left.botToken === right.botToken &&
			left.baseUrl === right.baseUrl &&
			left.userId === right.userId
		);
	}
	return false;
}

interface RuntimeConnection {
	snapshot: ConnectionSnapshot;
	host: OpenClawHostController;
	credentials?: Credential;
	pending?: OfficialLogin;
	qrCode?: QrCodeSnapshot;
	initializing?: Promise<void>;
	retryTimer?: NodeJS.Timeout;
}
const MIGRATION_LOCK_RETRY_PATTERN =
	/OpenClaw startup migrations are already running[\s\S]*?after\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

const PORT_CONFLICT_PATTERN =
	/is already in use|owned by another gateway process|bound an unexpected port|EADDRINUSE|already listening on/i;

function isPortConflict(error: unknown): boolean {
	return PORT_CONFLICT_PATTERN.test(error instanceof Error ? error.message : String(error));
}

function migrationLockRetryDelay(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const retryAt = MIGRATION_LOCK_RETRY_PATTERN.exec(message)?.[1];
	if (!retryAt) return undefined;
	const timestamp = Date.parse(retryAt);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.max(250, timestamp - Date.now() + 500);
}

function validOwner(value: string): string {
	const owner = value.trim();
	if (!owner || owner.length > 256 || /[\u0000-\u001f\u007f]/.test(owner)) {
		throw new AdapterError('owner_user_id_required', 400);
	}
	return owner;
}

function validId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(value)) {
		throw new AdapterError('invalid_connection_id', 400);
	}
	return value;
}

export class OpenClawAdapter implements ChannelAdapter {
	readonly mode = 'openclaw' as const;
	private readonly runtimes = new Map<string, RuntimeConnection>();
	private readonly startWeixinLogin: typeof startWeixinOfficialLogin;
	private readonly startQqLogin: typeof startQqOfficialLogin;
	private readonly legacyHostMode: boolean;
	private started = false;
	private detail = 'OpenClaw adapter has not started';
	private globalTail: Promise<void> = Promise.resolve();
	private readonly connectionTails = new Map<string, Promise<void>>();
	private supervisorTimer?: NodeJS.Timeout;
	private readonly assignedPorts = new Map<string, number>();
	private readonly portOwners = new Map<number, string>();
	private readonly blockedPorts = new Set<number>();

	constructor(
		private readonly config: GatewayConfig,
		private readonly state: GatewayStateStore,
		private readonly vault: CredentialVault,
		private readonly logger: Logger,
		dependencies: OpenClawAdapterDependencies = {}
	) {
		this.startWeixinLogin = dependencies.startWeixinLogin || startWeixinOfficialLogin;
		this.startQqLogin = dependencies.startQqLogin || startQqOfficialLogin;
		this.legacyHostMode = Boolean(dependencies.host);
		// The injected host remains supported for the existing adapter fixture.
		if (dependencies.host) this.runtimes.set('__legacy_host__', { snapshot: {} as ConnectionSnapshot, host: dependencies.host });
	}

	async start(): Promise<void> {
		await this.serialize(async () => {
			if (this.started) throw new Error('OpenClaw adapter is already started');
			const existing = this.state.listConnections();
			// Migrate the old env-driven singleton only when it already exists or when
			// the compatibility flags are explicitly present in a legacy deployment.
			for (const channel of this.legacyHostMode ? this.config.enabledChannels : []) {
				const id = `${channel}-default`;
				if (!existing.some((entry) => entry.id === id)) {
					await this.state.upsertConnection({ id, channel, ownerUserId: 'legacy', enabled: true, status: 'logged_out', updatedAt: new Date().toISOString(), detail: 'Legacy compatibility connection' });
				}
			}
			const legacy = this.runtimes.get('__legacy_host__');
			if (legacy) {
				const credentials: OpenClawCredentialSet = {};
				for (const connection of this.state.listConnections()) {
					const raw = await this.vault.get(connection.id);
					if (connection.channel === 'qq') {
						const credential = parseQqCredential(raw);
						if (credential) credentials.qq = credential;
					} else {
						const credential = parseWeixinCredential(raw);
						if (credential) credentials.wechat = credential;
					}
				}
				await legacy.host.start(credentials, { wechat: this.config.enabledChannels.has('wechat'), qq: this.config.enabledChannels.has('qq') });
			}
			this.started = true;
			try {
				this.detail = 'Per-user OpenClaw channel hosts are restoring; RyanAI owns all inference';
				// Credential materialization temporarily points OpenClaw's parent-process
				// environment at a connection-specific directory. Restore hosts in order
				// so two users can never write WeChat credentials into each other's state.
				for (const connection of this.state.listConnections()) {
					await this.serializeConnection(connection.id, () => this.ensureRuntime(connection));
				}
				this.startSupervisor();
			} catch (error) {
				this.started = false;
				await this.stopAllRuntimes();
				throw error;
			}
		});
	}

	async stop(): Promise<void> {
		await this.serialize(async () => {
			this.started = false;
			this.stopSupervisor();
			await this.stopAllRuntimes();
			this.detail = 'OpenClaw channel hosts are stopped';
		});
	}

	health(): AdapterHealth {
		const active = [...this.runtimes.values()].filter((entry) => entry.snapshot.id);
		const ready = this.started && active.every((entry) => !entry.credentials || entry.host.isRunning());
		return { mode: this.mode, ready, detail: ready ? this.detail : 'One or more OpenClaw connection hosts are not running' };
	}

	async listConnections(): Promise<ConnectionSnapshot[]> {
		return this.state.listConnections().filter((entry) => entry.id !== '__legacy_host__');
	}

	async createConnection(input: CreateConnectionInput): Promise<ConnectionSnapshot> {
		if (input.channel !== 'wechat' && input.channel !== 'qq') throw new AdapterError('invalid_channel', 400);
		const ownerUserId = validOwner(input.ownerUserId);
		const id = validId(input.id || `${input.channel}-${cryptoRandomId()}`);
		return this.serializeConnection(id, async () => {
			if (this.state.getConnection(id)) throw new AdapterError('connection_already_exists', 409);
			const snapshot: ConnectionSnapshot = {
				id, channel: input.channel, ownerUserId, enabled: input.enabled !== false,
				status: input.enabled === false ? 'disabled' : 'logged_out',
				updatedAt: new Date().toISOString(),
				detail: 'Connection created; credentials/login are not configured',
				...(input.accountLabel ? { accountLabel: input.accountLabel.slice(0, 512) } : {})
			};
			await this.state.upsertConnection(snapshot);
			if (this.started && snapshot.enabled) await this.ensureRuntime(snapshot);
			return structuredClone(this.state.getConnection(id) || snapshot);
		});
	}

	async deleteConnection(connectionId: string): Promise<void> {
		await this.serializeConnection(connectionId, async () => {
			const runtime = this.runtimes.get(connectionId);
			if (runtime) {
				this.clearRetry(runtime);
				const pending = runtime.pending;
				runtime.pending = undefined;
				runtime.qrCode = undefined;
				pending?.cancel();
				await runtime.host.stop();
				this.runtimes.delete(connectionId);
			}
			await this.vault.delete(connectionId);
			const deleted = await this.state.deleteConnection(connectionId);
			this.releasePort(connectionId);
			if (!deleted) throw new AdapterError('connection_not_found', 404);
		});
	}

	async patchConnection(connectionId: string, enabled: boolean): Promise<ConnectionSnapshot> {
		return this.serializeConnection(connectionId, async () => {
			const runtime = await this.runtimeFor(connectionId);
			runtime.snapshot = await this.state.patchConnection(connectionId, { enabled, status: enabled ? (runtime.snapshot.status === 'disabled' ? 'logged_out' : runtime.snapshot.status) : 'disabled' }) as ConnectionSnapshot;
			try {
				if (enabled) {
					if (runtime.credentials) {
						if (!runtime.host.isRunning()) await this.startHost(runtime, false);
						await this.refresh(runtime);
					} else {
						if (runtime.host.isRunning()) await runtime.host.stop();
						runtime.snapshot = await this.setStatus(runtime, 'logged_out', 'Credentials are not configured');
					}
				} else {
					const pending = runtime.pending;
					runtime.pending = undefined;
					runtime.qrCode = undefined;
					pending?.cancel();
					if (runtime.host.isRunning()) await runtime.host.stop();
				}
			} catch (error) {
				this.logger.error('Per-connection state change failed', { connection_id: connectionId, ...safeErrorFields(error) });
				throw new AdapterError('openclaw_restart_failed');
			}
			return structuredClone(runtime.snapshot);
		});
	}

	async login(connectionId: string, input: LoginInput): Promise<ConnectionSnapshot> {
		return this.serializeConnection(connectionId, async () => {
			const runtime = await this.runtimeFor(connectionId);
			if (!runtime.snapshot.enabled) throw new AdapterError('connection_disabled', 409);
			this.clearRetry(runtime);
			const previousPending = runtime.pending;
			runtime.pending = undefined;
			runtime.qrCode = undefined;
			previousPending?.cancel();
			if (runtime.snapshot.channel === 'qq') {
				const raw = input.credentials || (await this.vault.get(connectionId));
				if (raw) {
					const credential = parseQqCredential(raw);
					if (!credential) throw new AdapterError('invalid_qq_credentials', 400);
					await this.vault.put(connectionId, credential as unknown as Record<string, unknown>);
					runtime.credentials = credential;
					await this.restartRuntime(runtime);
					return structuredClone(runtime.snapshot);
				}
			}
			const pending = runtime.snapshot.channel === 'wechat'
				? await this.startWeixinLogin(this.connectionConfig(runtime.snapshot), this.logger, parseWeixinCredential(await this.vault.get(connectionId)), connectionId)
				: await this.startQqLogin(this.logger, connectionId);
			runtime.pending = pending;
			runtime.qrCode = structuredClone(pending.qrCode);
			runtime.snapshot = await this.setStatus(runtime, 'awaiting_scan', 'Waiting for official QR confirmation');
			pending.completion.then(
				(credential) => this.serializeConnection(connectionId, () => this.completeLogin(runtime, pending, credential)),
				(error) => this.serializeConnection(connectionId, () => this.failLogin(runtime, pending, error))
			).catch((error) => this.logger.error('QR completion handler failed', safeErrorFields(error)));
			return structuredClone(runtime.snapshot);
		});
	}

	async reconnect(connectionId: string): Promise<ConnectionSnapshot> {
		return this.serializeConnection(connectionId, async () => {
			const runtime = await this.runtimeFor(connectionId);
			if (!runtime.snapshot.enabled) throw new AdapterError('connection_disabled', 409);
			this.clearRetry(runtime);
			const raw = await this.vault.get(connectionId);
			runtime.credentials = runtime.snapshot.channel === 'qq' ? parseQqCredential(raw) : parseWeixinCredential(raw);
			await this.restartRuntime(runtime);
			return structuredClone(runtime.snapshot);
		});
	}

	async logout(connectionId: string): Promise<ConnectionSnapshot> {
		return this.serializeConnection(connectionId, async () => {
			const runtime = await this.runtimeFor(connectionId);
			this.clearRetry(runtime);
			const pending = runtime.pending;
			runtime.pending = undefined;
			runtime.qrCode = undefined;
			pending?.cancel();
			runtime.credentials = undefined;
			const { trustedOwnerExternalId: _trustedOwnerExternalId, ...withoutTrustedIdentity } = runtime.snapshot;
			runtime.snapshot = withoutTrustedIdentity;
			await this.vault.delete(connectionId);
			if (runtime.host.clearCredentials) {
				await runtime.host.clearCredentials();
			} else {
				// Keep injected legacy hosts compatible while ensuring their in-memory
				// credentials are cleared before the connection becomes logged out.
				await runtime.host.restart({}, this.channelFlags(runtime.snapshot));
				await runtime.host.stop();
			}
			return this.setStatus(runtime, runtime.snapshot.enabled ? 'logged_out' : 'disabled', 'Official channel credentials were removed');
		});
	}

	async getQrCode(connectionId: string): Promise<QrCodeSnapshot> {
		const runtime = await this.runtimeFor(connectionId);
		if (!runtime.qrCode || Date.parse(runtime.qrCode.expiresAt) <= Date.now()) throw new AdapterError('qr_code_not_available', 404);
		return structuredClone(runtime.qrCode);
	}

	async discoverGroups(connectionId: string): Promise<DiscoveredGroup[]> {
		await this.runtimeFor(connectionId);
		return this.state.listGroups({ connectionId });
	}

	private async ensureRuntime(snapshot: ConnectionSnapshot): Promise<RuntimeConnection> {
		const existing = this.runtimes.get(snapshot.id);
		if (existing) { existing.snapshot = snapshot; return existing; }
		const legacy = this.runtimes.get('__legacy_host__');
		const host = legacy && snapshot.id.endsWith('-default') ? legacy.host : new OpenClawHost(this.connectionConfig(snapshot), this.logger.child(snapshot.id));
		const runtime: RuntimeConnection = { snapshot, host };
		this.runtimes.set(snapshot.id, runtime);
		const raw = await this.vault.get(snapshot.id);
		runtime.credentials = snapshot.channel === 'qq' ? parseQqCredential(raw) : parseWeixinCredential(raw);
		await this.persistCredentialIdentity(runtime);
		// A user can start a fresh QR flow while persisted connections are still
		// restoring. Keep that new flow authoritative and do not start the old
		// credential host underneath it.
		if (runtime.pending) return runtime;
		if (!snapshot.enabled) return runtime;
		if (!runtime.credentials) {
			runtime.snapshot = await this.setStatus(runtime, 'logged_out', 'Credentials are not configured');
			return runtime;
		}
		try {
			if (!runtime.host.isRunning()) {
				try {
					await this.startHost(runtime, false);
				} catch (error) {
					if (await this.deferMigrationLockedRestart(runtime, error)) return runtime;
					throw error;
				}
			}
			if (!runtime.pending) await this.refresh(runtime);
		} catch (error) {
			runtime.snapshot = await this.setStatus(runtime, 'unavailable', 'OpenClaw connection host failed to start');
			this.logger.error('OpenClaw connection host failed', { connection_id: snapshot.id, ...safeErrorFields(error) });
		}
		return runtime;
	}

	private scheduleRuntimeInitialization(snapshot: ConnectionSnapshot): void {
		const initialization = this.ensureRuntime(snapshot);
		const runtime = this.runtimes.get(snapshot.id);
		if (!runtime) {
			void initialization.catch((error) =>
				this.logger.error('OpenClaw runtime initialization failed', {
					connection_id: snapshot.id,
					...safeErrorFields(error)
				})
			);
			return;
		}
		let tracked: Promise<void>;
		tracked = initialization
			.then(() => undefined)
			.catch((error) => {
				this.logger.error('OpenClaw runtime initialization failed', {
					connection_id: snapshot.id,
					...safeErrorFields(error)
				});
			})
			.finally(() => {
				if (runtime.initializing === tracked) runtime.initializing = undefined;
			});
		runtime.initializing = tracked;
	}

	private async runtimeFor(id: string): Promise<RuntimeConnection> {
		const snapshot = this.state.getConnection(id);
		if (!snapshot) throw new AdapterError('connection_not_found', 404);
		return this.runtimes.get(id) || this.ensureRuntime(snapshot);
	}

	private async restartRuntime(runtime: RuntimeConnection): Promise<void> {
		if (runtime.initializing) await runtime.initializing;
		if (!runtime.credentials) {
			if (runtime.host.isRunning()) await runtime.host.stop();
			runtime.snapshot = await this.setStatus(runtime, runtime.snapshot.enabled ? 'logged_out' : 'disabled', 'Credentials are not configured');
			return;
		}
		try {
			await this.startHost(runtime, true);
		} catch (error) {
			if (await this.deferMigrationLockedRestart(runtime, error)) return;
			throw error;
		}
		await this.refresh(runtime);
	}

	private async deferMigrationLockedRestart(
		runtime: RuntimeConnection,
		error: unknown
	): Promise<boolean> {
		const delayMs = migrationLockRetryDelay(error);
		if (delayMs === undefined) return false;
		this.clearRetry(runtime);
		runtime.snapshot = await this.setStatus(
			runtime,
			'degraded',
			'Credentials saved; waiting for the OpenClaw startup migration lock before reconnecting'
		);
		this.logger.warn('OpenClaw startup migration is locked; reconnect scheduled', {
			connection_id: runtime.snapshot.id,
			retry_in_ms: delayMs
		});
		runtime.retryTimer = setTimeout(() => {
			runtime.retryTimer = undefined;
			void this.serializeConnection(runtime.snapshot.id, async () => {
				if (!this.started || !runtime.snapshot.enabled || !runtime.credentials) return;
				try {
					await this.restartRuntime(runtime);
				} catch (retryError) {
					runtime.snapshot = await this.setStatus(
						runtime,
						'unavailable',
						'Credentials saved but channel could not connect'
					);
					this.logger.error('Scheduled OpenClaw reconnect failed', {
						connection_id: runtime.snapshot.id,
						...safeErrorFields(retryError)
					});
				}
			}).catch((retryError) =>
				this.logger.error('Scheduled OpenClaw reconnect handler failed', {
					connection_id: runtime.snapshot.id,
					...safeErrorFields(retryError)
				})
			);
		}, delayMs);
		runtime.retryTimer.unref();
		return true;
	}

	private clearRetry(runtime: RuntimeConnection): void {
		if (!runtime.retryTimer) return;
		clearTimeout(runtime.retryTimer);
		runtime.retryTimer = undefined;
	}

	private async refresh(runtime: RuntimeConnection): Promise<void> {
		if (!runtime.snapshot.enabled) { runtime.snapshot = await this.setStatus(runtime, 'disabled', 'Connection is disabled'); return; }
		if (!runtime.credentials) { runtime.snapshot = await this.setStatus(runtime, 'logged_out', 'Credentials are not configured'); return; }
		const status = await runtime.host.status(runtime.snapshot.channel);
		const detail = status.lastError || (status.connected ? 'Channel is connected' : 'Credentials are configured but channel is not connected');
		const probedAccountId = status.accountId?.trim();
		const accountLabel = probedAccountId && probedAccountId.toLowerCase() !== 'default'
			? probedAccountId
			: this.accountLabel(runtime.credentials);
		runtime.snapshot = await this.setStatus(runtime, status.connected ? 'connected' : 'degraded', detail, accountLabel);
	}

	private async completeLogin(runtime: RuntimeConnection, pending: OfficialLogin, credential: Credential): Promise<void> {
		if (
			!this.started ||
			this.runtimes.get(runtime.snapshot.id) !== runtime ||
			!this.state.getConnection(runtime.snapshot.id) ||
			runtime.pending !== pending
		) return;
		const unchangedCredential = sameCredential(runtime.credentials, credential);
		runtime.pending = undefined;
		runtime.credentials = credential;
		await this.persistCredentialIdentity(runtime);
		await this.vault.put(runtime.snapshot.id, credential as unknown as Record<string, unknown>);
		if (unchangedCredential && runtime.host.isRunning()) {
			runtime.snapshot = await this.setStatus(
				runtime,
				'connected',
				'Channel is already connected',
				this.accountLabel(credential)
			);
			runtime.qrCode = undefined;
			return;
		}
		runtime.snapshot = await this.setStatus(
			runtime,
			'degraded',
			'Credentials saved; channel is reconnecting',
			this.accountLabel(credential)
		);
		runtime.qrCode = undefined;
		try { await this.restartRuntime(runtime); } catch (error) { runtime.snapshot = await this.setStatus(runtime, 'degraded', 'Credentials saved but channel could not connect'); this.logger.error('QR login restart failed', safeErrorFields(error)); }
	}

	private async failLogin(runtime: RuntimeConnection, pending: OfficialLogin, error: unknown): Promise<void> {
		if (
			!this.started ||
			this.runtimes.get(runtime.snapshot.id) !== runtime ||
			!this.state.getConnection(runtime.snapshot.id) ||
			runtime.pending !== pending
		) return;
		runtime.pending = undefined; runtime.qrCode = undefined;
		runtime.snapshot = await this.setStatus(runtime, runtime.credentials ? 'degraded' : 'logged_out', 'Official QR login expired or failed');
		this.logger.warn('Official QR login failed', safeErrorFields(error));
	}

	private credentialsFor(runtime: RuntimeConnection): OpenClawCredentialSet {
		return runtime.snapshot.channel === 'qq' ? { ...(runtime.credentials ? { qq: runtime.credentials as QqLoginCredential } : {}) } : { ...(runtime.credentials ? { wechat: runtime.credentials as WeixinLoginCredential } : {}) };
	}

	private channelFlags(snapshot: ConnectionSnapshot): Record<Channel, boolean> { return { wechat: snapshot.channel === 'wechat' && snapshot.enabled, qq: snapshot.channel === 'qq' && snapshot.enabled }; }

	private connectionConfig(snapshot: ConnectionSnapshot): GatewayConfig {
		const openClawStateDir = path.join(this.config.openClawStateDir, snapshot.id, 'state');
		const openClawHomeDir = path.join(this.config.openClawHomeDir, snapshot.id, 'home');
		const parentGeneratedRoots = new Set([
			path.join(this.config.openClawStateDir, 'media'),
			path.join(this.config.openClawHomeDir, '.openclaw', 'media')
		]);
		const attachmentRoots = [
			...this.config.attachmentRoots.filter((root) => !parentGeneratedRoots.has(root)),
			path.join(openClawStateDir, 'media'),
			path.join(openClawHomeDir, '.openclaw', 'media')
		];
		return {
			...this.config,
			enabledChannels: new Set<Channel>([snapshot.channel]),
			openClawConnectionId: snapshot.id,
			openClawPort: this.allocatePort(snapshot.id),
			openClawStateDir,
			openClawHomeDir,
			attachmentRoots: [...new Set(attachmentRoots)]
		};
	}

	private async setStatus(runtime: RuntimeConnection, status: ConnectionStatus, detail: string, accountLabel?: string): Promise<ConnectionSnapshot> {
		const next: ConnectionSnapshot = { ...runtime.snapshot, status, detail, updatedAt: new Date().toISOString(), ...(accountLabel ? { accountLabel } : {}) };
		await this.state.upsertConnection(next); return next;
	}
	private accountLabel(credential: Credential): string { return 'appId' in credential ? credential.appId : credential.accountId; }
	private trustedOwnerExternalId(credential: Credential | undefined): string | undefined {
		const value = credential && ('appId' in credential ? credential.userOpenid : credential.userId);
		return value?.trim() || undefined;
	}
	private async persistCredentialIdentity(runtime: RuntimeConnection): Promise<void> {
		const trustedOwnerExternalId = this.trustedOwnerExternalId(runtime.credentials);
		if (!trustedOwnerExternalId || runtime.snapshot.trustedOwnerExternalId === trustedOwnerExternalId) return;
		runtime.snapshot = { ...runtime.snapshot, trustedOwnerExternalId, updatedAt: new Date().toISOString() };
		await this.state.upsertConnection(runtime.snapshot);
	}
	private allocatePort(connectionId: string): number {
		const existing = this.assignedPorts.get(connectionId);
		if (existing !== undefined) return existing;
		const minimum = 1_024;
		const span = 65_535 - minimum + 1;
		const start = (this.config.openClawPort - minimum + hashCode(connectionId)) % span;
		for (let attempt = 0; attempt < span; attempt += 1) {
			const port = minimum + ((start + attempt) % span);
			if (!this.portOwners.has(port) && !this.blockedPorts.has(port)) {
				this.assignedPorts.set(connectionId, port);
				this.portOwners.set(port, connectionId);
				return port;
			}
		}
		throw new Error('No OpenClaw ports are available');
	}
	private releasePort(connectionId: string): void {
		const port = this.assignedPorts.get(connectionId);
		if (port === undefined) return;
		this.assignedPorts.delete(connectionId);
		if (this.portOwners.get(port) === connectionId) this.portOwners.delete(port);
	}
	/**
	 * Move a connection onto a fresh port after its own port turned out to be held
	 * by a foreign or orphaned process. The host captures its port at construction,
	 * so the host object is rebuilt rather than restarted in place.
	 */
	private async rebindRuntime(runtime: RuntimeConnection): Promise<boolean> {
		const connectionId = runtime.snapshot.id;
		if (!connectionId || this.legacyHostMode || this.runtimes.get(connectionId) !== runtime) {
			return false;
		}
		const port = this.assignedPorts.get(connectionId);
		if (port !== undefined) this.blockedPorts.add(port);
		this.releasePort(connectionId);
		if (runtime.host.isRunning()) await runtime.host.stop();
		runtime.host = new OpenClawHost(
			this.connectionConfig(runtime.snapshot),
			this.logger.child(connectionId)
		);
		this.logger.warn('OpenClaw connection host moved to a free port', {
			connection_id: connectionId,
			previous_port: port,
			port: this.assignedPorts.get(connectionId)
		});
		return true;
	}
	/**
	 * Start (or restart) a connection host, stepping off ports that another process
	 * already owns instead of leaving the connection permanently unavailable.
	 */
	private async startHost(runtime: RuntimeConnection, restart: boolean): Promise<void> {
		let useRestart = restart;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			if (!this.started && !this.legacyHostMode) throw new AdapterError('adapter_stopped', 409);
			try {
				const credentials = this.credentialsFor(runtime);
				const flags = this.channelFlags(runtime.snapshot);
				if (useRestart) await runtime.host.restart(credentials, flags);
				else await runtime.host.start(credentials, flags);
				return;
			} catch (error) {
				if (!isPortConflict(error) || !(await this.rebindRuntime(runtime))) throw error;
				useRestart = false;
			}
		}
		throw new Error('OpenClaw host could not acquire a free port');
	}
	private startSupervisor(): void {
		this.stopSupervisor();
		this.supervisorTimer = setInterval(() => {
			this.superviseRuntimes();
		}, 15_000);
		this.supervisorTimer.unref();
	}
	private stopSupervisor(): void {
		if (!this.supervisorTimer) return;
		clearInterval(this.supervisorTimer);
		this.supervisorTimer = undefined;
	}
	private superviseRuntimes(): void {
		if (!this.started) return;
		for (const runtime of this.runtimes.values()) {
			const connectionId = runtime.snapshot.id;
			if (
				!connectionId ||
				!runtime.snapshot.enabled ||
				!runtime.credentials ||
				runtime.pending ||
				runtime.initializing ||
				runtime.retryTimer ||
				runtime.host.isRunning()
			) continue;
			void this.serializeConnection(connectionId, async () => {
				// Re-check under the connection lock: a login or restart may have
				// recovered the host while this sweep was queued.
				if (
					!this.started ||
					this.runtimes.get(connectionId) !== runtime ||
					!runtime.snapshot.enabled ||
					!runtime.credentials ||
					runtime.pending ||
					runtime.retryTimer ||
					runtime.host.isRunning()
				) return;
				runtime.snapshot = await this.setStatus(runtime, 'degraded', 'Channel host stopped; reconnecting');
				try {
					await this.restartRuntime(runtime);
				} catch (error) {
					runtime.snapshot = await this.setStatus(runtime, 'unavailable', 'Channel host restart failed');
					this.logger.error('OpenClaw channel host restart failed', {
						connection_id: connectionId,
						...safeErrorFields(error)
					});
				}
			}).catch((error) =>
				this.logger.error('OpenClaw runtime supervisor failed', {
					connection_id: connectionId,
					...safeErrorFields(error)
				})
			);
		}
	}
	private async stopAllRuntimes(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			this.clearRetry(runtime);
			const pending = runtime.pending;
			runtime.pending = undefined;
			runtime.qrCode = undefined;
			pending?.cancel();
			if (runtime.host.isRunning()) await runtime.host.stop();
		}
	}
	/** Adapter-wide exclusive section, for whole-adapter lifecycle only. */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.globalTail.then(operation);
		this.globalTail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}
	/**
	 * Per-connection exclusive section. QR logins and host restarts take minutes,
	 * so one user's onboarding must never queue behind another user's.
	 */
	private serializeConnection<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.connectionTails.get(connectionId) || Promise.resolve();
		const result = previous.then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined
		);
		this.connectionTails.set(connectionId, tail);
		void tail.then(() => {
			if (this.connectionTails.get(connectionId) === tail) this.connectionTails.delete(connectionId);
		});
		return result;
	}
}

function cryptoRandomId(): string {
	return randomBytes(8).toString('base64url');
}

function hashCode(value: string): number {
	let hash = 0; for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return hash >>> 0;
}
