import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { GatewayConfig } from '../config.js';
import { deriveLeaseBridgeSecret, deriveShardBridgeSecret } from '../config.js';
import { Logger, safeErrorFields } from '../logger.js';
import type { Channel } from '../types.js';
import { withOpenClawEnv } from './env-mutex.js';

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
		userOpenid?: string;
	};
}

export interface OpenClawAccountStatus {
	configured: boolean;
	running: boolean;
	connected: boolean;
	accountId?: string;
	lastError?: string;
}

/** One bot account hosted on a shared shard process. */
export interface OpenClawShardMember {
	connectionId: string;
	wechat?: OpenClawCredentialSet['wechat'];
	qq?: OpenClawCredentialSet['qq'];
}

interface ShardAssignment {
	shardId: string;
	channel: Channel;
	members: OpenClawShardMember[];
}

interface PackageInfo {
	root: string;
	version: string;
}

/**
 * Shape of the singleton lock the pinned OpenClaw gateway writes before it
 * binds its port. It records the pid that owns a given config path, which is
 * what lets the parent prove a reachable port belongs to the child it spawned.
 */
interface GatewayLockPayload {
	pid?: number;
	port?: number;
	configPath?: string;
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

function killProcessTree(
	child: ChildProcessByStdio<null, Readable, Readable>,
	signal: NodeJS.Signals
): void {
	if (child.pid !== undefined && process.platform !== 'win32') {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	}
	child.kill(signal);
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

/** Find the status entry belonging to one account in a status payload. */
function accountRecordFor(value: unknown, accountKey: string): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		return value.find(
			(entry): entry is Record<string, unknown> =>
				Boolean(entry) &&
				typeof entry === 'object' &&
				!Array.isArray(entry) &&
				text((entry as Record<string, unknown>).accountId) === accountKey
		);
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const nested = record[accountKey];
		if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			return nested as Record<string, unknown>;
		}
		if (text(record.accountId) === accountKey) return record;
	}
	return undefined;
}

function bool(value: unknown): boolean {
	return value === true;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize a WeChat account id with the pinned SDK's rules so the registry,
 * the materialized credential store, and inbound event accountIds all agree.
 */
export async function normalizeWeixinAccountKey(value: string): Promise<string> {
	const moduleSpecifier = 'openclaw/plugin-sdk/account-id';
	const accountIds = (await import(moduleSpecifier)) as {
		normalizeAccountId(value: string): string;
	};
	return accountIds.normalizeAccountId(value);
}

export interface OpenClawExitEvent {
	pid?: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	runtimeMs: number;
	expected: boolean;
}

export interface OpenClawProcessSnapshot {
	pid?: number;
	rssBytes?: number;
}

export class OpenClawHost {
	private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private packageRoots: Record<string, PackageInfo> | undefined;
	private credentials: OpenClawCredentialSet = {};
	private channelEnabled: Record<Channel, boolean> = { wechat: false, qq: false };
	private shard: ShardAssignment | undefined;
	private detail = 'OpenClaw host has not started';
	private commandTail: Promise<void> = Promise.resolve();
	private exitHandler?: (event: OpenClawExitEvent) => void;

	readonly configPath: string;
	private readonly tempDir: string;

	constructor(
		private readonly config: GatewayConfig,
		private readonly logger: Logger
	) {
		this.configPath = path.join(config.openClawStateDir, 'openclaw.json');
		this.tempDir = path.join(config.openClawStateDir, 'tmp');
	}

	isRunning(): boolean {
		return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
	}

	healthDetail(): string {
		return this.detail;
	}

	async processSnapshot(): Promise<OpenClawProcessSnapshot> {
		const pid = this.child?.pid;
		if (!pid) return {};
		try {
			const residentPages = Number((await readFile(`/proc/${pid}/statm`, 'utf8')).trim().split(/\s+/)[1]);
			return { pid, ...(Number.isFinite(residentPages) ? { rssBytes: residentPages * 4096 } : {}) };
		} catch {
			return { pid };
		}
	}

	onUnexpectedExit(handler: (event: OpenClawExitEvent) => void): void {
		this.exitHandler = handler;
	}

	async start(
		credentials: OpenClawCredentialSet,
		channelEnabled: Record<Channel, boolean>
	): Promise<void> {
		this.shard = undefined;
		this.credentials = structuredClone(credentials);
		this.channelEnabled = { ...channelEnabled };
		await this.launch();
	}

	/**
	 * Start this host as a shared shard serving every member account of one
	 * channel. Event attribution then relies on per-event account ids instead
	 * of a process-wide connection id.
	 */
	async startShard(
		shardId: string,
		channel: Channel,
		members: readonly OpenClawShardMember[]
	): Promise<void> {
		this.shard = { shardId, channel, members: structuredClone([...members]) };
		this.credentials = {};
		this.channelEnabled = { wechat: channel === 'wechat', qq: channel === 'qq' };
		await this.launch();
	}

	shardMembers(): OpenClawShardMember[] {
		return structuredClone(this.shard?.members ?? []);
	}

	private async launch(): Promise<void> {
		if (this.isRunning()) throw new Error('OpenClaw host is already running');
		if (await canConnect(this.config.openClawPort)) {
			throw new Error(`OpenClaw port ${this.config.openClawPort} is already in use`);
		}
		this.packageRoots = await this.verifyPackages();
		await Promise.all([
			mkdir(this.config.openClawStateDir, { recursive: true, mode: 0o700 }),
			mkdir(this.config.openClawHomeDir, { recursive: true, mode: 0o700 }),
			mkdir(this.tempDir, { recursive: true, mode: 0o700 }),
			mkdir(path.join(this.config.openClawStateDir, 'media'), {
				recursive: true,
				mode: 0o700
			}),
			mkdir(path.join(this.config.openClawHomeDir, '.openclaw', 'media'), {
				recursive: true,
				mode: 0o700
			})
			]);

		await this.seedManagedWeixinProject();
		await withOpenClawEnv(
			{
				OPENCLAW_STATE_DIR: this.config.openClawStateDir,
				OPENCLAW_CONFIG_PATH: this.configPath
			},
			async () => {
				if (this.shard) await this.materializeWeixinShardCredentials(this.shard.members);
				else await this.materializeWeixinCredentials(this.credentials.wechat);
				await this.clearQqCredentialBackups();
				await this.writeConfig();
			}
		);

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
				'none',
				'--allow-unconfigured'
			],
			{
				cwd: appRoot(),
				env: this.childEnvironment(),
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		this.child = child;
		const launchedAt = Date.now();
		let stderrTail = '';
		let startupError: Error | undefined;
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
			this.exitHandler?.({
				pid: child.pid,
				exitCode: code,
				signal,
				runtimeMs: Date.now() - launchedAt,
				expected: false
			});
		});
		child.once('error', (error) => {
			if (this.child === child) this.child = undefined;
			startupError = error;
			this.detail = 'OpenClaw host process failed';
			this.logger.error('OpenClaw host process failed', safeErrorFields(error));
		});

		const deadline = Date.now() + this.config.openClawStartupTimeoutMs;
		while (Date.now() < deadline) {
			if (startupError) throw startupError;
			if (child.exitCode !== null) {
				const startupDetail = stderrTail.trim().slice(-4_096);
				throw new Error(startupDetail || 'OpenClaw host exited during startup');
			}
			if (await canConnect(this.config.openClawPort)) {
				// A reachable port is not proof of ownership: an orphaned or foreign
				// gateway can hold it while this child loses the bind and exits. Only
				// treat the host as started once the gateway lock names this child.
				const owner = await this.readGatewayLockOwner();
				if (owner?.pid !== undefined) {
					if (owner.pid !== child.pid) {
						throw new Error(
							`OpenClaw port ${this.config.openClawPort} is owned by another gateway process`
						);
					}
					if (owner.port !== undefined && owner.port !== this.config.openClawPort) {
						throw new Error('OpenClaw host bound an unexpected port');
					}
					this.detail = 'OpenClaw host is running; RyanAI owns all message inference';
					return;
				}
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
		killProcessTree(child, 'SIGTERM');
		const exited = new Promise<boolean>((resolve) => {
			child.once('exit', () => resolve(true));
		});
		if (!(await Promise.race([exited, wait(10_000).then(() => false)]))) {
			killProcessTree(child, 'SIGKILL');
			await Promise.race([exited, wait(2_000)]);
		}
			this.detail = 'OpenClaw host is stopped';
	}

	async clearCredentials(): Promise<void> {
		await this.stop();
		this.credentials = {};
		this.channelEnabled = { wechat: false, qq: false };
		this.shard = undefined;
		this.packageRoots = undefined;
		this.detail = 'OpenClaw host credentials are cleared';
	}

	async restart(
		credentials = this.credentials,
		channelEnabled = this.channelEnabled
	): Promise<void> {
		await this.serialize(async () => {
			await this.stop();
			if (this.shard) await this.startShard(this.shard.shardId, this.shard.channel, this.shard.members);
			else await this.start(credentials, channelEnabled);
		});
	}

	/** Replace the member set and restart the shard process with it. */
	async restartShard(members?: readonly OpenClawShardMember[]): Promise<void> {
		await this.serialize(async () => {
			const shard = this.shard;
			if (!shard) throw new Error('OpenClaw host is not running as a shard');
			await this.stop();
			await this.startShard(shard.shardId, shard.channel, members ?? shard.members);
		});
	}

	async status(channel: Channel, accountKey?: string): Promise<OpenClawAccountStatus> {
		const configured = this.shard
			? this.shard.members.some((member) =>
					channel === 'wechat' ? Boolean(member.wechat) : Boolean(member.qq)
				)
			: channel === 'wechat'
				? Boolean(this.credentials.wechat)
				: Boolean(this.credentials.qq);
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
			const account = accountKey
				? accountRecordFor(accounts, accountKey)
				: firstRecord(accounts);
			const summaryByChannel = firstRecord(payload.channels);
			const summary = firstRecord(summaryByChannel?.[channelId]);
			if (accountKey && !account) {
				// A successful probe that does not list the account means the shard is
				// not actually hosting it; the channel-level summary must not mask that.
				return { configured, running: false, connected: false };
			}
			// With a specific account resolved, channel-level summary fields must not
			// leak one member's health onto another member of the same shard.
			const running = bool(account?.running) || (!accountKey && bool(summary?.running));
			const lastError =
				text(account?.lastError) || (!accountKey ? text(summary?.lastError) : undefined);
			// The WeChat plugin exposes a long-poll monitor as `running` and does not
			// include a separate `connected` flag. QQ exposes both fields, so retain
			// its explicit probe while treating a healthy WeChat monitor as connected.
			const connected =
				bool(account?.connected) ||
				(!accountKey && bool(summary?.connected)) ||
				(channel === 'wechat' && running && !lastError);
			return {
				configured:
					bool(account?.configured) || (!accountKey && bool(summary?.configured)) || configured,
				running,
				connected,
				accountId: text(account?.accountId) || (!accountKey ? text(summary?.accountId) : accountKey),
				lastError
			};
			} catch (error) {
				this.logger.warn('OpenClaw channel status probe failed', {
					channel,
					...safeErrorFields(error)
				});
				const running = this.isRunning();
				// A busy channel can time out the CLI probe while it is still receiving
				// messages. Keep a live, configured host online until a successful probe
				// reports a real channel error; otherwise a transient CLI failure makes
				// the administrator view disagree with a bot that is replying normally.
				return {
					configured,
					running,
					connected: configured && running
				};
			}
	}

	/**
	 * Path of the singleton lock the pinned OpenClaw gateway writes for this
	 * connection's config. `childEnvironment()` pins the child's temp directory,
	 * so the parent derives exactly the path the child uses.
	 */
	private gatewayLockPath(): string {
		const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
		const digest = createHash('sha256').update(this.configPath).digest('hex').slice(0, 8);
		return path.join(
			this.tempDir,
			uid === undefined ? 'openclaw' : `openclaw-${uid}`,
			`gateway.${digest}.lock`
		);
	}

	private async readGatewayLockOwner(): Promise<GatewayLockPayload | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.gatewayLockPath(), 'utf8');
		} catch {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as GatewayLockPayload)
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async verifyPackages(): Promise<Record<string, PackageInfo>> {		const entries = await Promise.all(
			Object.entries(PINNED_PACKAGES).map(async ([name, expected]) => {
				const info = await resolvePackageInfo(name);
				if (info.version !== expected) throw new Error(`Pinned package mismatch for ${name}`);
				return [name, info] as const;
			})
		);
		return Object.fromEntries(entries);
	}

	private async findManagedWeixinProject(projectsRoot: string): Promise<string | undefined> {
		let entries;
		try {
			entries = await readdir(projectsRoot, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith('tencent-weixin-openclaw-weixin-')) continue;
			const projectRoot = path.join(projectsRoot, entry.name);
			try {
				const metadata = JSON.parse(
					await readFile(
						path.join(
							projectRoot,
							'node_modules',
							'@tencent-weixin',
							'openclaw-weixin',
							'package.json'
						),
						'utf8'
					)
				) as { version?: string };
				if (metadata.version === PINNED_PACKAGES['@tencent-weixin/openclaw-weixin']) {
					return projectRoot;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
		return undefined;
	}

	private hasWeixinCredential(): boolean {
		return this.shard
			? this.shard.members.some((member) => Boolean(member.wechat))
			: Boolean(this.credentials.wechat);
	}

	private async seedManagedWeixinProject(): Promise<void> {
		if (!this.channelEnabled.wechat || !this.hasWeixinCredential()) return;
		const projectsRoot = path.join(this.config.openClawStateDir, 'npm', 'projects');
		if (await this.findManagedWeixinProject(projectsRoot)) return;

		const levelRoot = path.dirname(path.dirname(this.config.openClawStateDir));
		// A shard lives under <root>/shards/<shardId>/state; its grandparent root
		// still holds the old isolated per-connection trees worth seeding from.
		const searchRoots =
			path.basename(levelRoot) === 'shards'
				? [levelRoot, path.dirname(levelRoot)]
				: [levelRoot];
		for (const searchRoot of searchRoots) {
			let connectionDirs;
			try {
				connectionDirs = await readdir(searchRoot, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			for (const connectionDir of connectionDirs) {
				if (!connectionDir.isDirectory()) continue;
				const siblingStateDir = path.join(searchRoot, connectionDir.name, 'state');
				if (path.resolve(siblingStateDir) === path.resolve(this.config.openClawStateDir)) continue;
				const sourceProject = await this.findManagedWeixinProject(
					path.join(siblingStateDir, 'npm', 'projects')
				);
				if (!sourceProject) continue;

				await rm(projectsRoot, { recursive: true, force: true });
				await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
				await cp(sourceProject, path.join(projectsRoot, path.basename(sourceProject)), {
					recursive: true
				});
				this.logger.info('Seeded managed WeChat plugin dependencies from an existing isolated host');
				return;
			}
		}
	}

	private async writeConfig(): Promise<void> {
		if (!this.packageRoots) throw new Error('OpenClaw package roots are unavailable');
		const channelPlugins = [
			...(this.channelEnabled.wechat ? ['openclaw-weixin'] : []),
			...(this.channelEnabled.qq ? ['openclaw-qqbot'] : [])
		];
		const pluginPaths = [
			...(this.channelEnabled.wechat
				? [this.packageRoots['@tencent-weixin/openclaw-weixin']!.root]
				: []),
			...(this.channelEnabled.qq
				? [this.packageRoots['@tencent-connect/openclaw-qqbot']!.root]
				: []),
			appRoot()
		];
		const qqConfig: Record<string, unknown> = {
			enabled: this.channelEnabled.qq,
			dmPolicy: 'open',
			allowFrom: ['*'],
			groupPolicy: 'open',
			defaultRequireMention: true,
			upgradeMode: 'doc',
			streaming: { mode: 'off' },
			stt: { enabled: false },
			tts: { enabled: false }
		};
		if (this.shard) {
			// Shared shards key the accounts map by connection id, so inbound QQ
			// events carry the owning connection id as their accountId directly.
			const qqAccounts: Record<string, unknown> = {};
			for (const member of this.shard.members) {
				if (!member.qq) continue;
				qqAccounts[member.connectionId] = {
					enabled: true,
					appId: member.qq.appId,
					clientSecret: member.qq.appSecret
				};
			}
			qqConfig.enabled = this.channelEnabled.qq && Object.keys(qqAccounts).length > 0;
			qqConfig.accounts = qqAccounts;
		} else if (this.credentials.qq) {
			qqConfig.appId = this.credentials.qq.appId;
		}
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
				allow: [...channelPlugins, 'ryanai-bridge'],
				load: {
					paths: pluginPaths
				},
				entries: {
					'openclaw-weixin': { enabled: this.channelEnabled.wechat },
					'openclaw-qqbot': { enabled: this.channelEnabled.qq },
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
			// Pinning the temp directory keeps the gateway's singleton lock inside this
			// connection's state tree, which both isolates it from other connections and
			// lets `start()` prove the reachable port belongs to the child it spawned.
			TMPDIR: this.tempDir,
			TMP: this.tempDir,
			TEMP: this.tempDir,
			OPENCLAW_STATE_DIR: this.config.openClawStateDir,
			OPENCLAW_CONFIG_PATH: this.configPath,
			OPENCLAW_HIDE_BANNER: '1',
			OPENCLAW_SUPPRESS_NOTES: '1',
			BOT_GATEWAY_ENABLED: 'true',
			BOT_GATEWAY_ADAPTER: 'openclaw',
			BOT_GATEWAY_INTERNAL_PORT: String(this.config.internalPort),
			BOT_GATEWAY_HMAC_SECRET: this.shard
				? this.config.coordinationMode === 'redis' &&
						this.config.openClawNodeId &&
						this.config.openClawLeaseEpoch !== undefined
					? deriveLeaseBridgeSecret(
							this.config.hmacSecret,
							this.shard.shardId,
							this.config.openClawNodeId,
							this.config.openClawLeaseEpoch
						)
					: deriveShardBridgeSecret(this.config.hmacSecret, this.shard.shardId)
				: this.config.bridgeHmacSecret,
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
			...(this.shard
				? {
						BOT_GATEWAY_OPENCLAW_SHARD_ID: this.shard.shardId,
						...(this.config.coordinationMode === 'redis'
							? {
									...(this.config.openClawNodeId
										? { BOT_GATEWAY_NODE_ID: this.config.openClawNodeId }
										: {}),
									...(this.config.openClawLeaseEpoch !== undefined
										? { BOT_GATEWAY_LEASE_EPOCH: String(this.config.openClawLeaseEpoch) }
										: {}),
									...(this.config.openClawAssignmentGeneration !== undefined
										? {
												BOT_GATEWAY_ASSIGNMENT_GENERATION: String(
													this.config.openClawAssignmentGeneration
												)
											}
										: {})
								}
							: {})
					}
				: { BOT_GATEWAY_OPENCLAW_CONNECTION_ID: this.config.openClawConnectionId || '' }),
			...(!this.shard && this.credentials.qq
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

	private async materializeWeixinShardCredentials(
		members: readonly OpenClawShardMember[]
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
		const wanted = new Map<string, NonNullable<OpenClawCredentialSet['wechat']>>();
		for (const member of members) {
			if (!member.wechat) continue;
			wanted.set(await this.normalizeAccountId(member.wechat.accountId), member.wechat);
		}
		for (const existingId of accounts.listIndexedWeixinAccountIds()) {
			if (!wanted.has(existingId)) {
				accounts.clearWeixinAccount(existingId);
				accounts.unregisterWeixinAccountId(existingId);
			}
		}
		for (const [accountId, credential] of wanted) {
			accounts.saveWeixinAccount(accountId, {
				token: credential.botToken,
				baseUrl: credential.baseUrl,
				userId: credential.userId
			});
			accounts.registerWeixinAccountId(accountId);
		}
	}

	private async normalizeAccountId(value: string): Promise<string> {
		return normalizeWeixinAccountKey(value);
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
