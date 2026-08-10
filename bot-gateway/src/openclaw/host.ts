import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { GatewayConfig } from '../config.js';
import { Logger, safeErrorFields } from '../logger.js';
import type { Channel } from '../types.js';

const PINNED_PACKAGES = {
	openclaw: '2026.7.1-2',
	'@tencent-weixin/openclaw-weixin': '2.4.6',
	'@tencent-connect/openclaw-qqbot': '2.0.0'
} as const;

const WEIXIN_ACCOUNTS_MODULE = '@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js';

export interface OpenClawCredentialSet {
	wechat?: {
		accountId: string;
		botToken: string;
		baseUrl?: string;
		userId?: string;
	};
	qq?: {
		appId: string;
		appSecret: string;
	};
}

export interface OpenClawAccountStatus {
	configured: boolean;
	running: boolean;
	connected: boolean;
	accountId?: string;
	lastError?: string;
}

interface PackageInfo {
	root: string;
	version: string;
}

function appRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function resolvePackageInfo(specifier: string): Promise<PackageInfo> {
	const require = createRequire(import.meta.url);
	let entry: string;
	try {
		entry = require.resolve(specifier);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
		// Some official channel packages intentionally expose only their OpenClaw
		// extension metadata and have no Node root entry point.
		entry = require.resolve(`${specifier}/package.json`);
	}
	let current = path.dirname(entry);
	for (;;) {
		const candidate = path.join(current, 'package.json');
		try {
			const parsed = JSON.parse(await readFile(candidate, 'utf8')) as {
				name?: string;
				version?: string;
			};
			if (parsed.name === specifier && parsed.version) {
				return { root: current, version: parsed.version };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`Cannot locate package metadata for ${specifier}`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tempPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600
	});
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EEXIST' && code !== 'EPERM') throw error;
		await copyFile(tempPath, filePath);
		await unlink(tempPath);
	}
}

function wait(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		timer.unref();
	});
}

async function canConnect(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port });
		const finish = (connected: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};
		socket.setTimeout(1_000);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		return value.find(
			(entry): entry is Record<string, unknown> =>
				Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
		);
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function bool(value: unknown): boolean {
	return value === true;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class OpenClawHost {
	private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private packageRoots: Record<string, PackageInfo> | undefined;
	private credentials: OpenClawCredentialSet = {};
	private channelEnabled: Record<Channel, boolean> = { wechat: false, qq: false };
	private detail = 'OpenClaw host has not started';
	private commandTail: Promise<void> = Promise.resolve();

	readonly configPath: string;

	constructor(
		private readonly config: GatewayConfig,
		private readonly logger: Logger
	) {
		this.configPath = path.join(config.openClawStateDir, 'openclaw.json');
	}

	isRunning(): boolean {
		return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
	}

	healthDetail(): string {
		return this.detail;
	}

	async start(
		credentials: OpenClawCredentialSet,
		channelEnabled: Record<Channel, boolean>
	): Promise<void> {
		if (this.isRunning()) throw new Error('OpenClaw host is already running');
		this.credentials = structuredClone(credentials);
		this.channelEnabled = { ...channelEnabled };
		this.packageRoots = await this.verifyPackages();
		await Promise.all([
			mkdir(this.config.openClawStateDir, { recursive: true, mode: 0o700 }),
			mkdir(this.config.openClawHomeDir, { recursive: true, mode: 0o700 }),
			mkdir(path.join(this.config.openClawStateDir, 'media'), {
				recursive: true,
				mode: 0o700
			}),
			mkdir(path.join(this.config.openClawHomeDir, '.openclaw', 'media'), {
				recursive: true,
				mode: 0o700
			})
		]);

		process.env.OPENCLAW_STATE_DIR = this.config.openClawStateDir;
		process.env.OPENCLAW_CONFIG_PATH = this.configPath;
		await this.materializeWeixinCredentials(credentials.wechat);
		await this.clearQqCredentialBackups();
		await this.writeConfig();

		const openClawEntry = path.join(this.packageRoots.openclaw!.root, 'openclaw.mjs');
		const child = spawn(
			process.execPath,
			[
				openClawEntry,
				'gateway',
				'run',
				'--bind',
				'loopback',
				'--port',
				String(this.config.openClawPort),
				'--auth',
				'none'
			],
			{
				cwd: appRoot(),
				env: this.childEnvironment(),
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		this.child = child;
		let stderrTail = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
		});
		child.stdout.resume();
		child.once('exit', (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.detail = `OpenClaw host exited (${code ?? signal ?? 'unknown'})`;
			this.logger.error('OpenClaw host exited', {
				exit_code: code,
				signal,
				stderr_tail: stderrTail.trim().slice(-4_096)
			});
		});
		child.once('error', (error) => {
			this.detail = 'OpenClaw host process failed';
			this.logger.error('OpenClaw host process failed', safeErrorFields(error));
		});

		const deadline = Date.now() + this.config.openClawStartupTimeoutMs;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new Error('OpenClaw host exited during startup');
			}
			if (await canConnect(this.config.openClawPort)) {
				this.detail = 'OpenClaw host is running; RyanAI owns all message inference';
				return;
			}
			await wait(250);
		}
		await this.stop();
		throw new Error('OpenClaw host startup timed out');
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child || child.exitCode !== null) return;
		child.kill('SIGTERM');
		const exited = new Promise<boolean>((resolve) => {
			child.once('exit', () => resolve(true));
		});
		if (!(await Promise.race([exited, wait(10_000).then(() => false)]))) {
			child.kill('SIGKILL');
			await Promise.race([exited, wait(2_000)]);
		}
		this.detail = 'OpenClaw host is stopped';
	}

	async restart(
		credentials = this.credentials,
		channelEnabled = this.channelEnabled
	): Promise<void> {
		await this.serialize(async () => {
			await this.stop();
			await this.start(credentials, channelEnabled);
		});
	}

	async status(channel: Channel): Promise<OpenClawAccountStatus> {
		const configured =
			channel === 'wechat' ? Boolean(this.credentials.wechat) : Boolean(this.credentials.qq);
		if (!this.isRunning()) return { configured, running: false, connected: false };
		const channelId = channel === 'wechat' ? 'openclaw-weixin' : 'qqbot';
		try {
			const output = await this.runCli(
				[
					'gateway',
					'call',
					'channels.status',
					'--params',
					JSON.stringify({ channel: channelId, probe: true, timeoutMs: 8_000 }),
					'--timeout',
					'10000',
					'--json'
				],
				15_000
			);
			const payload = JSON.parse(output) as Record<string, unknown>;
			const accountsByChannel = firstRecord(payload.channelAccounts);
			const accounts = accountsByChannel?.[channelId];
			const account = firstRecord(accounts);
			const summaryByChannel = firstRecord(payload.channels);
			const summary = firstRecord(summaryByChannel?.[channelId]);
			const running = bool(account?.running) || bool(summary?.running);
			const connected = bool(account?.connected) || bool(summary?.connected) || running;
			return {
				configured: bool(account?.configured) || bool(summary?.configured) || configured,
				running,
				connected,
				accountId: text(account?.accountId) || text(summary?.accountId),
				lastError: text(account?.lastError) || text(summary?.lastError)
			};
		} catch (error) {
			this.logger.warn('OpenClaw channel status probe failed', {
				channel,
				...safeErrorFields(error)
			});
			return { configured, running: false, connected: false };
		}
	}

	private async verifyPackages(): Promise<Record<string, PackageInfo>> {
		const entries = await Promise.all(
			Object.entries(PINNED_PACKAGES).map(async ([name, expected]) => {
				const info = await resolvePackageInfo(name);
				if (info.version !== expected) throw new Error(`Pinned package mismatch for ${name}`);
				return [name, info] as const;
			})
		);
		return Object.fromEntries(entries);
	}

	private async writeConfig(): Promise<void> {
		if (!this.packageRoots) throw new Error('OpenClaw package roots are unavailable');
		const qqConfig: Record<string, unknown> = {
			enabled: this.channelEnabled.qq,
			dmPolicy: 'open',
			allowFrom: ['*'],
			groupPolicy: 'open',
			defaultRequireMention: true,
			upgradeMode: 'doc',
			streaming: { mode: 'off' },
			stt: { enabled: false },
			tts: { enabled: false },
			...(this.credentials.qq ? { appId: this.credentials.qq.appId } : {})
		};
		await writeJsonAtomic(this.configPath, {
			gateway: {
				mode: 'local',
				bind: 'loopback',
				port: this.config.openClawPort,
				auth: { mode: 'none' },
				controlUi: { enabled: false }
			},
			diagnostics: { enabled: false },
			session: { dmScope: 'per-account-channel-peer' },
			plugins: {
				enabled: true,
				allow: ['openclaw-weixin', 'openclaw-qqbot', 'ryanai-bridge'],
				load: {
					paths: [
						this.packageRoots['@tencent-weixin/openclaw-weixin']!.root,
						this.packageRoots['@tencent-connect/openclaw-qqbot']!.root,
						appRoot()
					]
				},
				entries: {
					'openclaw-weixin': { enabled: true },
					'openclaw-qqbot': { enabled: true },
					'ryanai-bridge': {
						enabled: true,
						hooks: { allowConversationAccess: true, allowPromptInjection: false }
					}
				}
			},
			channels: {
				'openclaw-weixin': { enabled: this.channelEnabled.wechat },
				qqbot: qqConfig
			}
		});
	}

	private childEnvironment(): NodeJS.ProcessEnv {
		const passthrough = [
			'PATH',
			'Path',
			'PATHEXT',
			'SYSTEMROOT',
			'SystemRoot',
			'WINDIR',
			'LANG',
			'LC_ALL',
			'TZ',
			'HTTP_PROXY',
			'HTTPS_PROXY',
			'NO_PROXY',
			'http_proxy',
			'https_proxy',
			'no_proxy',
			'SSL_CERT_FILE',
			'SSL_CERT_DIR'
		];
		const env: NodeJS.ProcessEnv = {};
		for (const name of passthrough) {
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, {
			NODE_ENV: 'production',
			HOME: this.config.openClawHomeDir,
			USERPROFILE: this.config.openClawHomeDir,
			OPENCLAW_STATE_DIR: this.config.openClawStateDir,
			OPENCLAW_CONFIG_PATH: this.configPath,
			OPENCLAW_HIDE_BANNER: '1',
			OPENCLAW_SUPPRESS_NOTES: '1',
			BOT_GATEWAY_ENABLED: 'true',
			BOT_GATEWAY_ADAPTER: 'openclaw',
			BOT_GATEWAY_INTERNAL_PORT: String(this.config.internalPort),
			BOT_GATEWAY_HMAC_SECRET: this.config.bridgeHmacSecret,
			BOT_GATEWAY_DATA_DIR: this.config.dataDir,
			BOT_GATEWAY_OPENCLAW_STATE_DIR: this.config.openClawStateDir,
			BOT_GATEWAY_OPENCLAW_HOME_DIR: this.config.openClawHomeDir,
			BOT_GATEWAY_ATTACHMENT_ROOTS: this.config.attachmentRoots.join(path.delimiter),
			BOT_GATEWAY_REQUEST_TIMEOUT_MS: String(this.config.requestTimeoutMs),
			BOT_GATEWAY_REPLAY_TTL_MS: String(this.config.replayTtlMs),
			BOT_GATEWAY_SIGNATURE_MAX_SKEW_SECONDS: String(this.config.signatureMaxSkewSeconds),
			BOT_GATEWAY_MAX_EVENT_AGE_MS: String(this.config.maxEventAgeMs),
			BOT_GATEWAY_MAX_ATTACHMENT_BYTES: String(this.config.maxAttachmentBytes),
			BOT_GATEWAY_MAX_TOTAL_ATTACHMENT_BYTES: String(this.config.maxTotalAttachmentBytes),
			BOT_GATEWAY_MAX_INPUT_TEXT_CHARS: String(this.config.maxInputTextChars),
			BOT_GATEWAY_MAX_RESPONSE_TEXT_CHARS: String(this.config.maxResponseTextChars),
			BOT_GATEWAY_WECHAT_REPLY_CHARS: String(this.config.replyChunkChars.wechat),
			BOT_GATEWAY_QQ_REPLY_CHARS: String(this.config.replyChunkChars.qq),
			BOT_GATEWAY_SAFE_ERROR_MESSAGE: this.config.safeErrorMessage,
			BOT_GATEWAY_WECHAT_ENABLED: this.config.enabledChannels.has('wechat') ? 'true' : 'false',
			BOT_GATEWAY_QQ_ENABLED: this.config.enabledChannels.has('qq') ? 'true' : 'false',
			BOT_GATEWAY_OPENCLAW_CONNECTION_ID: this.config.openClawConnectionId || '',
			...(this.credentials.qq
				? {
						QQBOT_APP_ID: this.credentials.qq.appId,
						QQBOT_CLIENT_SECRET: this.credentials.qq.appSecret
					}
				: {})
		});
		return env;
	}

	private async runCli(args: string[], timeoutMs: number): Promise<string> {
		if (!this.packageRoots) throw new Error('OpenClaw package roots are unavailable');
		const openClawEntry = path.join(this.packageRoots.openclaw!.root, 'openclaw.mjs');
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [openClawEntry, ...args], {
				cwd: appRoot(),
				env: this.childEnvironment(),
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let stdout = '';
			let stderr = '';
			const cap = 4 * 1024 * 1024;
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				stdout = `${stdout}${chunk}`.slice(-cap);
			});
			child.stderr.on('data', (chunk: string) => {
				stderr = `${stderr}${chunk}`.slice(-cap);
			});
			const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
			timer.unref();
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once('exit', (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(`OpenClaw CLI failed (${code}); stderr=${Boolean(stderr.trim())}`));
					return;
				}
				resolve(stdout.trim());
			});
		});
	}

	private async materializeWeixinCredentials(
		credential: OpenClawCredentialSet['wechat']
	): Promise<void> {
		const accounts = (await import(WEIXIN_ACCOUNTS_MODULE)) as {
			clearWeixinAccount(accountId: string): void;
			listIndexedWeixinAccountIds(): string[];
			registerWeixinAccountId(accountId: string): void;
			saveWeixinAccount(
				accountId: string,
				update: { token?: string; baseUrl?: string; userId?: string }
			): void;
			unregisterWeixinAccountId(accountId: string): void;
		};
		const accountId = credential ? await this.normalizeAccountId(credential.accountId) : undefined;
		for (const existingId of accounts.listIndexedWeixinAccountIds()) {
			if (!accountId || existingId !== accountId) {
				accounts.clearWeixinAccount(existingId);
				accounts.unregisterWeixinAccountId(existingId);
			}
		}
		if (!credential || !accountId) return;
		accounts.saveWeixinAccount(accountId, {
			token: credential.botToken,
			baseUrl: credential.baseUrl,
			userId: credential.userId
		});
		accounts.registerWeixinAccountId(accountId);
	}

	private async normalizeAccountId(value: string): Promise<string> {
		const moduleSpecifier = 'openclaw/plugin-sdk/account-id';
		const accountIds = (await import(moduleSpecifier)) as {
			normalizeAccountId(value: string): string;
		};
		return accountIds.normalizeAccountId(value);
	}

	private async clearQqCredentialBackups(): Promise<void> {
		const dataDir = path.join(this.config.openClawHomeDir, '.openclaw', 'qqbot', 'data');
		for (const filePath of [
			path.join(dataDir, 'credential-backup', 'current.json'),
			path.join(dataDir, 'credential-backup.json')
		]) {
			try {
				await unlink(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.commandTail.then(operation);
		this.commandTail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}
}

export { PINNED_PACKAGES };
