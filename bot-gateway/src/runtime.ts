import { MockAdapter } from './adapters/mock.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import type { ChannelAdapter } from './adapters/types.js';
import type { GatewayConfig } from './config.js';
import { createCoordinator, type GatewayCoordinator } from './coordination.js';
import { GatewayControlPlaneClient } from './control-plane-client.js';
import { ControlServer } from './control-server.js';
import { DisabledControlServer } from './disabled-server.js';
import { RyanAiGateway } from './gateway.js';
import { Logger } from './logger.js';
import { RyanAiClient, type RyanAiTransport } from './ryanai-client.js';
import { CredentialVault } from './security/vault.js';
import { GatewayStateStore } from './state.js';
import type { ConnectionLoadSnapshot } from './gateway.js';
import type { ConnectionSnapshot } from './types.js';

const DETERMINISTIC_ACCOUNT_ERROR = /(?:already bound|invalid (?:app|credential|secret)|authentication failed|unauthorized|forbidden|credential (?:expired|rejected|revoked))/i;

export function buildConnectionLoadHeartbeat(
	loads: Record<string, ConnectionLoadSnapshot>,
	connections: ConnectionSnapshot[],
	streaks: Map<string, number>
): Record<string, ConnectionLoadSnapshot> {
	const emptyLoad = (): ConnectionLoadSnapshot => ({
		event_rate_5m: 0,
		event_rate_30m: 0,
		processing_seconds_per_minute: 0,
		processing_seconds_per_minute_30m: 0,
		attachment_mib_per_minute: 0,
		attachment_mib_per_minute_30m: 0,
		account_errors_10m: 0,
		account_error_streak: 0
	});
	const currentIds = new Set(connections.map((connection) => connection.id));
	for (const connectionId of streaks.keys()) {
		if (!currentIds.has(connectionId)) streaks.delete(connectionId);
	}
	for (const connection of connections) {
		const deterministicFailure =
			(connection.status === 'degraded' || connection.status === 'unavailable') &&
			DETERMINISTIC_ACCOUNT_ERROR.test(connection.detail ?? '');
		const streak = deterministicFailure ? (streaks.get(connection.id) ?? 0) + 1 : 0;
		streaks.set(connection.id, streak);
		const load = loads[connection.id] ?? emptyLoad();
		load.account_error_streak = streak;
		loads[connection.id] = load;
	}
	return loads;
}

export interface EnabledGatewayRuntime {
	enabled: true;
	config: GatewayConfig;
	state: GatewayStateStore;
	vault: CredentialVault;
	gateway: RyanAiGateway;
	adapter: ChannelAdapter;
	controlServer: ControlServer;
	coordinator: GatewayCoordinator;
	start(): Promise<number>;
	stop(): Promise<void>;
}

export interface DisabledGatewayRuntime {
	enabled: false;
	config: GatewayConfig;
	controlServer: DisabledControlServer;
	start(): Promise<number>;
	stop(): Promise<void>;
}

export type GatewayRuntime = EnabledGatewayRuntime | DisabledGatewayRuntime;

export interface RuntimeDependencies {
	transport?: RyanAiTransport;
	logger?: Logger;
}

export async function createRuntime(
	config: GatewayConfig,
	dependencies: RuntimeDependencies = {}
): Promise<GatewayRuntime> {
	const logger = dependencies.logger || new Logger('bot-gateway');
	if (!config.enabled) {
		const controlServer = new DisabledControlServer(config, logger.child('disabled-control'));
		return {
			enabled: false,
			config,
			controlServer,
			start: () => controlServer.start(),
			stop: () => controlServer.stop()
		};
	}

	const state = new GatewayStateStore(config.dataDir, config.replayTtlMs);
	const vault = new CredentialVault(config.dataDir, config.credentialsEncryptionKey);
	try {
		await Promise.all([state.initialize(), vault.initialize()]);
	} catch (error) {
		await state.close().catch(() => undefined);
		throw error;
	}
	const transport = dependencies.transport || new RyanAiClient(config);
	const gateway = new RyanAiGateway(config, state, transport, logger.child('bridge'));
	const coordinator = createCoordinator(config, logger);
	const controlPlane = new GatewayControlPlaneClient(config);
	const authoritativeControlPlane = config.coordinationMode === 'redis';
	const adapter: ChannelAdapter =
		config.adapterMode === 'mock'
			? new MockAdapter(config, state, gateway)
			: new OpenClawAdapter(config, state, vault, logger.child('openclaw-adapter'), {
				coordinator,
				...(authoritativeControlPlane ? { controlPlane } : {})
			});
	const controlServer = new ControlServer(
		config,
		adapter,
		state,
		vault,
		gateway,
		coordinator,
		logger.child('control')
	);
	if (adapter.fenceShard) gateway.onStaleFence((shardId) => adapter.fenceShard!(shardId));
	coordinator.setSnapshotProvider(async () => ({
		queue: gateway.queueSnapshot(),
		...(adapter.operationsSnapshot ? { operations: await adapter.operationsSnapshot() } : {})
	}));

	let reconcileTimer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	const accountErrorStreaks = new Map<string, number>();
	const heartbeatMetrics = async () => buildConnectionLoadHeartbeat(
		gateway.loadSnapshot(),
		await adapter.listConnections(),
		accountErrorStreaks
	);
	const sendHeartbeat = async () => controlPlane.heartbeat({ connections: await heartbeatMetrics() });
	return {
		enabled: true,
		config,
		state,
		vault,
		gateway,
		adapter,
		controlServer,
		coordinator,
		async start() {
			const port = await controlServer.start();
			try {
				await coordinator.start();
				if (authoritativeControlPlane) {
					await controlPlane.registerNode();
					await controlPlane.syncDesiredState(state);
				}
				await adapter.start();
				if (authoritativeControlPlane) {
					await sendHeartbeat();
					reconcileTimer = setInterval(() => {
						void controlPlane.syncDesiredState(state)
							.then(() => adapter.reconcile?.())
							.catch((error) => logger.error('Bot gateway desired-state reconcile failed', {
								error_message: error instanceof Error ? error.message : String(error)
							}));
					}, 10_000);
					reconcileTimer.unref();
				} else {
					void controlPlane.registerNode()
						.then(sendHeartbeat)
						.catch(() => undefined);
				}
				heartbeatTimer = setInterval(() => void sendHeartbeat().catch(() => undefined), 10_000);
				heartbeatTimer.unref();
				return port;
				} catch (error) {
					await controlServer.stop();
					await coordinator.stop().catch(() => undefined);
					await state.close();
					throw error;
			}
		},
		async stop() {
			if (reconcileTimer) clearInterval(reconcileTimer);
			reconcileTimer = undefined;
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			try {
				await gateway.shutdown();
				await controlServer.stop();
				await adapter.stop();
			} finally {
				await coordinator.stop().catch(() => undefined);
				await state.close();
			}
		}
	};
}
