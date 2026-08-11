import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { OpenClawAdapter } from '../src/adapters/openclaw.js';
import type { GatewayConfig } from '../src/config.js';
import type { OpenClawCredentialSet } from '../src/openclaw/host.js';
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
	assert.equal(host.credentials.qq?.appId, 'app-1');
	assert.equal(state.getConnection('qq-default')?.status, 'connected');
	assert.equal(state.getConnection('wechat-default')?.status, 'logged_out');
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
