import { createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Channel } from './types.js';

export const RYANAI_EVENT_PATH = '/api/v1/internal/bot-gateway/events';
export const OPENCLAW_BRIDGE_PATH = '/v1/openclaw/events';
const MIN_SECRET_LENGTH = 32;

export interface GatewayConfig {
	enabled: boolean;
	host: string;
	internalPort: number;
	hmacSecret: string;
	bridgeHmacSecret: string;
	credentialsEncryptionKey: Buffer;
	dataDir: string;
	ryanAiBaseUrl: URL;
	eventPath: typeof RYANAI_EVENT_PATH;
	bridgePath: typeof OPENCLAW_BRIDGE_PATH;
	adapterMode: 'mock' | 'openclaw';
	openClawStateDir: string;
	openClawHomeDir: string;
	openClawPort: number;
	openClawConnectionId?: string;
	openClawStartupTimeoutMs: number;
	enabledChannels: ReadonlySet<Channel>;
	requestTimeoutMs: number;
	replayTtlMs: number;
	signatureMaxSkewSeconds: number;
	maxEventAgeMs: number;
	maxAttachmentBytes: number;
	maxTotalAttachmentBytes: number;
	maxControlBodyBytes: number;
	maxInputTextChars: number;
	maxResponseTextChars: number;
	replyChunkChars: Readonly<Record<Channel, number>>;
	safeErrorMessage: string;
	attachmentRoots: readonly string[];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim() === '') return fallback;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new Error(`Invalid boolean configuration value: ${value}`);
}

function parseInteger(
	name: string,
	value: string | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

function requireSecret(name: string, value: string | undefined): string {
	if (!value || value.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`${name} is required and must contain at least ${MIN_SECRET_LENGTH} characters`
		);
	}
	return value;
}

export function parseEncryptionKey(value: string | undefined): Buffer {
	if (!value) {
		throw new Error('BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY is required');
	}

	const trimmed = value.trim();
	const decoded = /^[a-fA-F0-9]{64}$/.test(trimmed)
		? Buffer.from(trimmed, 'hex')
		: Buffer.from(trimmed, 'base64');

	if (decoded.length !== 32) {
		throw new Error(
			'BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hexadecimal characters'
		);
	}
	return decoded;
}

function parseBaseUrl(value: string | undefined): URL {
	const url = new URL(value?.trim() || 'http://ryanai:8080');
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('RYANAI_BASE_URL must use http or https');
	}
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return url;
}

export interface LoadConfigOptions {
	requireCredentialsEncryptionKey?: boolean;
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	options: LoadConfigOptions = {}
): GatewayConfig {
	const enabled = parseBoolean(env.BOT_GATEWAY_ENABLED, false);
	const adapterValue = (env.BOT_GATEWAY_ADAPTER || 'openclaw').trim().toLowerCase();
	if (adapterValue !== 'mock' && adapterValue !== 'openclaw') {
		throw new Error('BOT_GATEWAY_ADAPTER must be either mock or openclaw');
	}

	const configuredChannels = new Set<Channel>();
	if (parseBoolean(env.BOT_GATEWAY_WECHAT_ENABLED, false)) configuredChannels.add('wechat');
	if (parseBoolean(env.BOT_GATEWAY_QQ_ENABLED, false)) configuredChannels.add('qq');

	const dataDir = path.resolve(env.BOT_GATEWAY_DATA_DIR?.trim() || '/data');
	const openClawStateDir = path.resolve(
		env.BOT_GATEWAY_OPENCLAW_STATE_DIR?.trim() || path.join(os.tmpdir(), 'ryanai-openclaw-state')
	);
	const openClawHomeDir = path.resolve(
		env.BOT_GATEWAY_OPENCLAW_HOME_DIR?.trim() || path.join(os.tmpdir(), 'ryanai-openclaw-home')
	);
	const configuredAttachmentRoots = (env.BOT_GATEWAY_ATTACHMENT_ROOTS || '')
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => path.resolve(entry));
	const attachmentRoots = [
		...new Set([
			...configuredAttachmentRoots,
			path.join(openClawStateDir, 'media'),
			path.join(openClawHomeDir, '.openclaw', 'media')
		])
	];

	const maxTotalAttachmentBytes = parseInteger(
		'BOT_GATEWAY_MAX_TOTAL_ATTACHMENT_BYTES',
		env.BOT_GATEWAY_MAX_TOTAL_ATTACHMENT_BYTES,
		50 * 1024 * 1024,
		1,
		256 * 1024 * 1024
	);

	const hmacSecret = enabled
		? requireSecret('BOT_GATEWAY_HMAC_SECRET', env.BOT_GATEWAY_HMAC_SECRET)
		: '';

	return {
		enabled,
		host: env.BOT_GATEWAY_INTERNAL_HOST?.trim() || '0.0.0.0',
		internalPort: parseInteger(
			'BOT_GATEWAY_INTERNAL_PORT',
			env.BOT_GATEWAY_INTERNAL_PORT,
			8787,
			1,
			65535
		),
		hmacSecret,
		bridgeHmacSecret: enabled
			? createHmac('sha256', hmacSecret).update('ryanai-openclaw-bridge-v1').digest('hex')
			: '',
		credentialsEncryptionKey:
			enabled && options.requireCredentialsEncryptionKey !== false
				? parseEncryptionKey(env.BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY)
				: Buffer.alloc(0),
		dataDir,
		ryanAiBaseUrl: parseBaseUrl(env.RYANAI_BASE_URL),
		eventPath: RYANAI_EVENT_PATH,
		bridgePath: OPENCLAW_BRIDGE_PATH,
		adapterMode: adapterValue,
		openClawStateDir,
		openClawHomeDir,
		openClawPort: parseInteger(
			'BOT_GATEWAY_OPENCLAW_PORT',
			env.BOT_GATEWAY_OPENCLAW_PORT,
			18_789,
			1,
			65_535
		),
		openClawStartupTimeoutMs: parseInteger(
			'BOT_GATEWAY_OPENCLAW_STARTUP_TIMEOUT_MS',
			env.BOT_GATEWAY_OPENCLAW_STARTUP_TIMEOUT_MS,
			45_000,
			5_000,
			180_000
		),
		// The value remains exposed for legacy health/config consumers. The
		// production OpenClaw adapter deliberately ignores it when discovering
		// accounts; connections are created through the signed control API.
		enabledChannels: configuredChannels,
		requestTimeoutMs: parseInteger(
			'BOT_GATEWAY_REQUEST_TIMEOUT_MS',
			env.BOT_GATEWAY_REQUEST_TIMEOUT_MS,
			120_000,
			1_000,
			600_000
		),
		replayTtlMs: parseInteger(
			'BOT_GATEWAY_REPLAY_TTL_MS',
			env.BOT_GATEWAY_REPLAY_TTL_MS,
			24 * 60 * 60 * 1_000,
			60_000,
			7 * 24 * 60 * 60 * 1_000
		),
		signatureMaxSkewSeconds: parseInteger(
			'BOT_GATEWAY_SIGNATURE_MAX_SKEW_SECONDS',
			env.BOT_GATEWAY_SIGNATURE_MAX_SKEW_SECONDS,
			300,
			30,
			3_600
		),
		maxEventAgeMs: parseInteger(
			'BOT_GATEWAY_MAX_EVENT_AGE_MS',
			env.BOT_GATEWAY_MAX_EVENT_AGE_MS,
			10 * 60 * 1_000,
			30_000,
			24 * 60 * 60 * 1_000
		),
		maxAttachmentBytes: parseInteger(
			'BOT_GATEWAY_MAX_ATTACHMENT_BYTES',
			env.BOT_GATEWAY_MAX_ATTACHMENT_BYTES,
			20 * 1024 * 1024,
			1,
			100 * 1024 * 1024
		),
		maxTotalAttachmentBytes,
		maxControlBodyBytes: maxTotalAttachmentBytes + 2 * 1024 * 1024,
		maxInputTextChars: parseInteger(
			'BOT_GATEWAY_MAX_INPUT_TEXT_CHARS',
			env.BOT_GATEWAY_MAX_INPUT_TEXT_CHARS,
			50_000,
			1,
			500_000
		),
		maxResponseTextChars: parseInteger(
			'BOT_GATEWAY_MAX_RESPONSE_TEXT_CHARS',
			env.BOT_GATEWAY_MAX_RESPONSE_TEXT_CHARS,
			100_000,
			100,
			1_000_000
		),
		replyChunkChars: {
			wechat: parseInteger(
				'BOT_GATEWAY_WECHAT_REPLY_CHARS',
				env.BOT_GATEWAY_WECHAT_REPLY_CHARS,
				1_800,
				100,
				10_000
			),
			qq: parseInteger(
				'BOT_GATEWAY_QQ_REPLY_CHARS',
				env.BOT_GATEWAY_QQ_REPLY_CHARS,
				1_800,
				100,
				10_000
			)
		},
		safeErrorMessage:
			env.BOT_GATEWAY_SAFE_ERROR_MESSAGE?.trim() || 'Ryan AI 暂时无法处理这条消息，请稍后重试。',
		attachmentRoots
	};
}

export function assertSupportedNode(version = process.versions.node): void {
	const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
	const supported = major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 3)));
	if (!supported) {
		throw new Error(`Node.js >=22.22.3 is required; current version is ${version}`);
	}
}
