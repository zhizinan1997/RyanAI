import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { GatewayConfig } from '../src/config.js';
import { OPENCLAW_BRIDGE_PATH, RYANAI_EVENT_PATH } from '../src/config.js';
import { Logger, type LogSink } from '../src/logger.js';
import type { Channel, GatewayInboundEvent } from '../src/types.js';

export async function tempDataDir(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'ryanai-bot-gateway-test-'));
}

export function testConfig(dataDir: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
	return {
		enabled: true,
		host: '127.0.0.1',
		internalPort: 0,
		hmacSecret: 'hmac-secret-that-is-definitely-longer-than-32-bytes',
		bridgeHmacSecret: 'bridge-secret-that-is-definitely-longer-than-32-bytes',
		credentialsEncryptionKey: Buffer.alloc(32, 7),
		dataDir,
		ryanAiBaseUrl: new URL('http://127.0.0.1:9'),
		eventPath: RYANAI_EVENT_PATH,
		bridgePath: OPENCLAW_BRIDGE_PATH,
		adapterMode: 'mock',
		openClawStateDir: path.join(dataDir, 'openclaw-state'),
		openClawHomeDir: path.join(dataDir, 'openclaw-home'),
		openClawPort: 18_789,
		openClawStartupTimeoutMs: 5_000,
		enabledChannels: new Set<Channel>(['wechat', 'qq']),
		requestTimeoutMs: 1_000,
		replayTtlMs: 60_000,
		signatureMaxSkewSeconds: 300,
		maxEventAgeMs: 600_000,
		maxAttachmentBytes: 1_048_576,
		maxTotalAttachmentBytes: 2_097_152,
		maxControlBodyBytes: 3_145_728,
		maxInputTextChars: 50_000,
		maxResponseTextChars: 100_000,
		replyChunkChars: { wechat: 10, qq: 10 },
		safeErrorMessage: 'SAFE ERROR',
		attachmentRoots: [],
		...overrides
	};
}

export function inboundEvent(overrides: Partial<GatewayInboundEvent> = {}): GatewayInboundEvent {
	return {
		eventId: 'event-1',
		occurredAt: Date.now(),
		channel: 'wechat',
		connectionId: 'wechat-default',
		conversation: { type: 'private', id: 'user-1' },
		sender: { id: 'user-1' },
		message: { text: 'hello', mentionsBot: true },
		attachments: [],
		...overrides
	};
}

export function quietLogger(lines: string[] = []): Logger {
	const sink: LogSink = { write: (line) => lines.push(line) };
	return new Logger('test', sink);
}
