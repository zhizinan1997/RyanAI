import { assertSupportedNode, loadConfig } from './config.js';
import { Logger, safeErrorFields } from './logger.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
	assertSupportedNode();
	const config = loadConfig();
	const logger = new Logger('bot-gateway');
	const runtime = await createRuntime(config, { logger });
	const port = await runtime.start();
	logger.info('RyanAI Bot Gateway started', {
		enabled: config.enabled,
		host: config.host,
		port,
		adapter_mode: config.enabled ? config.adapterMode : 'disabled',
		enabled_channels: [...config.enabledChannels],
		ryanai_origin: config.ryanAiBaseUrl.origin
	});

	let stopping = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info('Stopping RyanAI Bot Gateway', { signal });
		try {
			await runtime.stop();
			process.exitCode = 0;
		} catch (error) {
			logger.error('Gateway shutdown failed', safeErrorFields(error));
			process.exitCode = 1;
		}
	};
	process.once('SIGINT', () => void shutdown('SIGINT'));
	process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
	const logger = new Logger('bot-gateway');
	logger.error('Gateway startup failed closed', safeErrorFields(error));
	process.exitCode = 1;
});
