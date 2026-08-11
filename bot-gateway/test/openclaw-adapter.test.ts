import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import type { GatewayConfig } from '../src/config.js';
import { OpenClawHost, type OpenClawCredentialSet } from '../src/openclaw/host.js';
import type {
	PendingOfficialLogin,
	WeixinLoginCredential
} from '../src/openclaw/official-login.js';
import { CredentialVault } from '../src/security/vault.js';
import { GatewayStateStore } from '../src/state.js';
import type { Channel, ConnectionSnapshot } from '../src/types.js';
import { quietLogger, tempDataDir, testConfig } from './helpers.js';

const require = createRequire(import.meta.url);

class FakeOpenClawHost {
	running = false;
	credentials: OpenClawCredentialSet = {};
	enabled: Record<Channel, boolean> = { wechat: false, qq: false };
	restartCount = 0;
	restartFailures: Error[] = [];

	isRunning(): boolean {
		return this.running;
	}

	healthDetail(): string {
		return this.running ? 'running' : 'stopped';
	}

	async start(
		credentials: OpenClawCredentialSet,
		enabled: Record<Channel, boolean>
	): Promise<void> {
		this.credentials = structuredClone(credentials);
		this.enabled = { ...enabled };
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
	}

	async restart(
		credentials: OpenClawCredentialSet = this.credentials,
		enabled: Record<Channel, boolean> = this.enabled
	): Promise<void> {
		this.restartCount += 1;
		await this.stop();
		const failure = this.restartFailures.shift();
		if (failure) throw failure;
		await this.start(credentials, enabled);
	}

	async status(channel: Channel) {
		const credential = channel === 'wechat' ? this.credentials.wechat : this.credentials.qq;
		return {
			configured: Boolean(credential),
			running: this.running && this.enabled[channel] && Boolean(credential),
			connected: this.running && this.enabled[channel] && Boolean(credential),
			...(channel === 'wechat' && this.credentials.wechat
				? { accountId: this.credentials.wechat.accountId }
				: {}),
			...(channel === 'qq' && this.credentials.qq ? { accountId: this.credentials.qq.appId } : {})
		};
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('condition_timeout');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test('installed QQBot bundle narrowly allows the official image and file download hosts', async () => {
	const bundle = await readFile(require.resolve('@tencent-connect/openclaw-qqbot'), 'utf8');
	assert.match(
		bundle,
		/\["multimedia\.nt\.qq\.com\.cn", "grouptalk\.c2c\.qq\.com"\]\.includes/
	);
	assert.match(bundle, /hostnameAllowlist: \[new URL\(url\)\.hostname\.toLowerCase\(\)\]/);
	assert.match(bundle, /dangerouslyAllowPrivateNetwork: true/);
});

test('per-connection hosts trust their own media directories without trusting sibling hosts', async () => {
	const dataDir = await tempDataDir();
	const customRoot = path.join(dataDir, 'custom-attachments');
	const config = testConfig(dataDir, {
		adapterMode: 'openclaw',
		attachmentRoots: [
			customRoot,
			path.join(dataDir, 'openclaw-state', 'media'),
			path.join(dataDir, 'openclaw-home', '.openclaw', 'media')
		]
	});
	const adapter = new OpenClawAdapter(
		config,
		new GatewayStateStore(dataDir, config.replayTtlMs),
		new CredentialVault(dataDir, config.credentialsEncryptionKey),
		quietLogger()
	);
	const snapshot: ConnectionSnapshot = {
		id: 'bot-wechat-user-1',
		channel: 'wechat',
		ownerUserId: 'user-1',
		enabled: true,
		status: 'connected',
		updatedAt: new Date().toISOString()
	};
	const childConfig = (
		adapter as unknown as {
			connectionConfig(snapshot: ConnectionSnapshot): GatewayConfig;
		}
	).connectionConfig(snapshot);

	assert.deepEqual(new Set(childConfig.attachmentRoots), new Set([
		customRoot,
		path.join(childConfig.openClawStateDir, 'media'),
		path.join(childConfig.openClawHomeDir, '.openclaw', 'media')
	]));
	assert.equal(
		childConfig.attachmentRoots.includes(path.join(config.openClawStateDir, 'media')),
		false
	);
	await rm(dataDir, { recursive: true, force: true });
});

test('every connection host gets its own port and steps off ports another process holds', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const adapter = new OpenClawAdapter(
		config,
		new GatewayStateStore(dataDir, config.replayTtlMs),
		new CredentialVault(dataDir, config.credentialsEncryptionKey),
		quietLogger()
	);
	const internals = adapter as unknown as {
		allocatePort(connectionId: string): number;
		releasePort(connectionId: string): void;
		blockedPorts: Set<number>;
	};

	const ports = ['bot-wechat-user-1', 'bot-wechat-user-2', 'bot-qq-user-3'].map((id) =>
		internals.allocatePort(id)
	);
	assert.equal(new Set(ports).size, ports.length);
	assert.equal(internals.allocatePort('bot-wechat-user-1'), ports[0]);
	for (const port of ports) {
		assert.equal(port >= 1_024 && port <= 65_535, true);
	}

	// A port a foreign or orphaned process already owns must never be handed back
	// out, otherwise a failed host would retry onto the same conflict forever.
	const taken = ports[0]!;
	internals.releasePort('bot-wechat-user-1');
	internals.blockedPorts.add(taken);
	const rebound = internals.allocatePort('bot-wechat-user-1');
	assert.notEqual(rebound, taken);
	assert.equal(ports.includes(rebound), false);

	await rm(dataDir, { recursive: true, force: true });
});

test('connection ids cannot escape their per-user OpenClaw directories', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger());

	await assert.rejects(
		adapter.createConnection({
			channel: 'wechat',
			ownerUserId: 'user-1',
			id: 'user/../../escape'
		}),
		/invalid_connection_id/
	);
	await rm(dataDir, { recursive: true, force: true });
});

test('new WeChat hosts reuse a complete managed plugin project from an existing host', async () => {
	const dataDir = await tempDataDir();
	const isolatedStateRoot = path.join(dataDir, 'openclaw-state');
	const sourceProject = path.join(
		isolatedStateRoot,
		'existing-user',
		'state',
		'npm',
		'projects',
		'tencent-weixin-openclaw-weixin-test'
	);
	await mkdir(
		path.join(sourceProject, 'node_modules', '@tencent-weixin', 'openclaw-weixin'),
		{ recursive: true }
	);
	await writeFile(
		path.join(sourceProject, 'node_modules', '@tencent-weixin', 'openclaw-weixin', 'package.json'),
		JSON.stringify({ version: '2.4.6' })
	);
	await writeFile(path.join(sourceProject, 'package-lock.json'), 'managed-project-marker');

	const config = testConfig(dataDir, {
		adapterMode: 'openclaw',
		openClawStateDir: path.join(isolatedStateRoot, 'new-user', 'state'),
		openClawHomeDir: path.join(dataDir, 'openclaw-home', 'new-user', 'home')
	});
	const host = new OpenClawHost(config, quietLogger());
	const internalHost = host as unknown as {
		credentials: OpenClawCredentialSet;
		channelEnabled: Record<Channel, boolean>;
		seedManagedWeixinProject(): Promise<void>;
	};
	internalHost.credentials = { wechat: { accountId: 'wx-account', botToken: 'token' } };
	internalHost.channelEnabled = { wechat: true, qq: false };

	await internalHost.seedManagedWeixinProject();

	assert.equal(
		await readFile(
			path.join(
				config.openClawStateDir,
				'npm',
				'projects',
				path.basename(sourceProject),
				'package-lock.json'
			),
			'utf8'
		),
		'managed-project-marker'
	);
	await rm(dataDir, { recursive: true, force: true });
});

test('OpenClaw adapter restores encrypted QQ credentials and stays healthy without WeChat login', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	await vault.put('qq-default', { app_id: 'app-1', app_secret: 'secret-1' });
	const host = new FakeOpenClawHost();
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), { host });

	await adapter.start();

	assert.equal(adapter.health().ready, true);
	await waitFor(() => state.getConnection('qq-default')?.status === 'connected');
	assert.equal(host.credentials.qq?.appId, 'app-1');
	assert.equal(state.getConnection('qq-default')?.status, 'connected');
	assert.equal(state.getConnection('wechat-default')?.status, 'logged_out');
	await adapter.stop();
	await rm(dataDir, { recursive: true, force: true });
});

test('OpenClaw adapter replaces the generic QQ account id with the configured app id', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	await vault.put('qq-default', { app_id: 'qq-app-1', app_secret: 'secret-1' });
	const host = new FakeOpenClawHost();
	host.status = async (channel: Channel) => ({
		configured: channel === 'qq',
		running: channel === 'qq',
		connected: channel === 'qq',
		accountId: 'default'
	});
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), { host });

	await adapter.start();
	await waitFor(() => state.getConnection('qq-default')?.status === 'connected');

	assert.equal(state.getConnection('qq-default')?.accountLabel, 'qq-app-1');
	await adapter.stop();
	await rm(dataDir, { recursive: true, force: true });
});

test('OpenClaw adapter persists an official WeChat QR result and removes it on logout', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	const host = new FakeOpenClawHost();
	let resolveCredential!: (credential: WeixinLoginCredential) => void;
	const completion = new Promise<WeixinLoginCredential>((resolve) => {
		resolveCredential = resolve;
	});
	const pending: PendingOfficialLogin<WeixinLoginCredential> = {
		qrCode: {
			connectionId: 'wechat-default',
			dataUrl: 'data:image/png;base64,AA==',
			expiresAt: new Date(Date.now() + 60_000).toISOString()
		},
		completion,
		cancel: () => undefined
	};
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), {
		host,
		startWeixinLogin: async () => pending
	});
	await adapter.start();

	const awaiting = await adapter.login('wechat-default', {});
	assert.equal(awaiting.status, 'awaiting_scan');
	assert.equal((await adapter.getQrCode('wechat-default')).dataUrl, pending.qrCode.dataUrl);

	resolveCredential({ accountId: 'wx-account', botToken: 'wx-token' });
	await waitFor(() => state.getConnection('wechat-default')?.status === 'connected');
	assert.equal((await vault.get('wechat-default'))?.botToken, 'wx-token');
	assert.equal(host.credentials.wechat?.accountId, 'wx-account');
	assert.ok(host.restartCount >= 1);

	const loggedOut = await adapter.logout('wechat-default');
	assert.equal(loggedOut.status, 'logged_out');
	assert.equal(await vault.get('wechat-default'), undefined);
	assert.equal(host.credentials.wechat, undefined);
	await adapter.stop();
	await rm(dataDir, { recursive: true, force: true });
});

test('OpenClaw adapter reconnects automatically after a transient startup migration lock', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	const host = new FakeOpenClawHost();
	host.restartFailures.push(
		new Error(
			`OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after ${new Date(Date.now() + 20).toISOString()}.`
		)
	);
	let resolveCredential!: (credential: WeixinLoginCredential) => void;
	const completion = new Promise<WeixinLoginCredential>((resolve) => {
		resolveCredential = resolve;
	});
	const pending: PendingOfficialLogin<WeixinLoginCredential> = {
		qrCode: {
			connectionId: 'wechat-default',
			dataUrl: 'data:image/png;base64,AA==',
			expiresAt: new Date(Date.now() + 60_000).toISOString()
		},
		completion,
		cancel: () => undefined
	};
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), {
		host,
		startWeixinLogin: async () => pending
	});
	await adapter.start();
	await adapter.login('wechat-default', {});

	resolveCredential({ accountId: 'wx-account', botToken: 'wx-token' });
	await waitFor(() => state.getConnection('wechat-default')?.status === 'degraded');
	assert.match(state.getConnection('wechat-default')?.detail || '', /migration lock/);
	await waitFor(() => state.getConnection('wechat-default')?.status === 'connected');
	assert.equal(host.restartCount, 2);

	await adapter.stop();
	await rm(dataDir, { recursive: true, force: true });
});

test('rescanning an already connected WeChat credential finishes without restarting the host', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	await vault.put('wechat-default', { accountId: 'wx-account', botToken: 'wx-token' });
	const host = new FakeOpenClawHost();
	let resolveCredential!: (credential: WeixinLoginCredential) => void;
	const completion = new Promise<WeixinLoginCredential>((resolve) => {
		resolveCredential = resolve;
	});
	const pending: PendingOfficialLogin<WeixinLoginCredential> = {
		qrCode: {
			connectionId: 'wechat-default',
			dataUrl: 'data:image/png;base64,AA==',
			expiresAt: new Date(Date.now() + 60_000).toISOString()
		},
		completion,
		cancel: () => undefined
	};
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), {
		host,
		startWeixinLogin: async () => pending
	});
	await adapter.start();
	await waitFor(() => state.getConnection('wechat-default')?.status === 'connected');

	const awaiting = await adapter.login('wechat-default', {});
	assert.equal(awaiting.status, 'awaiting_scan');
	resolveCredential({ accountId: 'wx-account', botToken: 'wx-token' });
	await waitFor(() => state.getConnection('wechat-default')?.status === 'connected');
	assert.equal(state.getConnection('wechat-default')?.detail, 'Channel is already connected');
	assert.equal(host.restartCount, 0);
	await assert.rejects(() => adapter.getQrCode('wechat-default'), /qr_code_not_available/);

	await adapter.stop();
	await rm(dataDir, { recursive: true, force: true });
});
