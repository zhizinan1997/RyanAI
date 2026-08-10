import { MockAdapter } from './adapters/mock.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import type { ChannelAdapter } from './adapters/types.js';
import type { GatewayConfig } from './config.js';
import { ControlServer } from './control-server.js';
import { DisabledControlServer } from './disabled-server.js';
import { RyanAiGateway } from './gateway.js';
import { Logger } from './logger.js';
import { RyanAiClient, type RyanAiTransport } from './ryanai-client.js';
import { CredentialVault } from './security/vault.js';
import { GatewayStateStore } from './state.js';

export interface EnabledGatewayRuntime {
	enabled: true;
	config: GatewayConfig;
	state: GatewayStateStore;
	vault: CredentialVault;
	gateway: RyanAiGateway;
	adapter: ChannelAdapter;
	controlServer: ControlServer;
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
	await Promise.all([state.initialize(), vault.initialize()]);
	const transport = dependencies.transport || new RyanAiClient(config);
	const gateway = new RyanAiGateway(config, state, transport, logger.child('bridge'));
	const adapter: ChannelAdapter =
		config.adapterMode === 'mock'
			? new MockAdapter(config, state, gateway)
			: new OpenClawAdapter(config, state, vault, logger.child('openclaw-adapter'));
	const controlServer = new ControlServer(
		config,
		adapter,
		state,
		vault,
		gateway,
		logger.child('control')
	);

	return {
		enabled: true,
		config,
		state,
		vault,
		gateway,
		adapter,
		controlServer,
		async start() {
			const port = await controlServer.start();
			try {
				await adapter.start();
				return port;
			} catch (error) {
				await controlServer.stop();
				throw error;
			}
		},
		async stop() {
			await controlServer.stop();
			await adapter.stop();
		}
	};
}
