import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { OpenClawAdapter, type ShardHostController } from '../src/adapters/openclaw.js';
import { deriveShardBridgeSecret } from '../src/config.js';
import { withOpenClawEnv } from '../src/openclaw/env-mutex.js';
import {
	OpenClawHost,
	normalizeWeixinAccountKey,
	type OpenClawAccountStatus,
	type OpenClawShardMember
} from '../src/openclaw/host.js';
import { normalizeMessageHook } from '../src/openclaw/normalize.js';
import type { PendingOfficialLogin, WeixinLoginCredential } from '../src/openclaw/official-login.js';
import { assignShard, migrateIsolatedWeixinState, shardIdFor } from '../src/openclaw/shard-manager.js';
import { createRuntime } from '../src/runtime.js';
import { buildEventMultipart } from '../src/ryanai-client.js';
import { signRequest } from '../src/security/hmac.js';
import { CredentialVault } from '../src/security/vault.js';
import { GatewayStateStore } from '../src/state.js';
import type { Channel, ConnectionSnapshot, GatewayInboundEvent } from '../src/types.js';
import { inboundEvent, quietLogger, tempDataDir, testConfig } from './helpers.js';

class FakeShardHost implements ShardHostController {
	running = false;
	shardId?: string;
	channel?: Channel;
	members: OpenClawShardMember[] = [];
	startCount = 0;
	restartCount = 0;

	isRunning(): boolean {
		return this.running;
	}

	healthDetail(): string {
		return this.running ? 'running' : 'stopped';
	}

	async startShard(
		shardId: string,
		channel: Channel,
		members: readonly OpenClawShardMember[]
	): Promise<void> {
		this.shardId = shardId;
		this.channel = channel;
		this.members = structuredClone([...members]);
		this.running = true;
		this.startCount += 1;
	}

	async restartShard(members: readonly OpenClawShardMember[] = this.members): Promise<void> {
		this.restartCount += 1;
		this.members = structuredClone([...members]);
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
	}

	async status(_channel: Channel, accountKey?: string): Promise<OpenClawAccountStatus> {
		const member = accountKey
			? await this.memberForAccount(accountKey)
			: this.members[0];
		const alive = this.running && Boolean(member);
		return {
			configured: Boolean(member),
			running: alive,
			connected: alive,
			...(accountKey ? { accountId: accountKey } : {})
		};
	}

	shardMembers(): OpenClawShardMember[] {
		return structuredClone(this.members);
	}

	private async memberForAccount(accountKey: string): Promise<OpenClawShardMember | undefined> {
		for (const member of this.members) {
			if (member.qq && member.connectionId === accountKey) return member;
			if (member.wechat) {
				const normalized = await normalizeWeixinAccountKey(member.wechat.accountId).catch(
					() => member.wechat!.accountId
				);
				if (normalized === accountKey || member.wechat.accountId === accountKey) return member;
			}
		}
		return undefined;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('condition_timeout');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface SharedFixture {
	dataDir: string;
	state: GatewayStateStore;
	vault: CredentialVault;
	adapter: OpenClawAdapter;
	shardHosts: FakeShardHost[];
}

async function sharedFixture(options: {
	capacity?: number;
	connections: Array<{
		id: string;
		channel: Channel;
		credentials?: Record<string, unknown>;
	}>;
	startWeixinLogin?: () => Promise<PendingOfficialLogin<WeixinLoginCredential>>;
}): Promise<SharedFixture> {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, {
		adapterMode: 'openclaw',
		openClawTopology: 'shared',
		openClawShardCapacity: options.capacity ?? 12
	});
	const state = new GatewayStateStore(dataDir, config.replayTtlMs);
	const vault = new CredentialVault(dataDir, config.credentialsEncryptionKey);
	await Promise.all([state.initialize(), vault.initialize()]);
	for (const connection of options.connections) {
		await state.upsertConnection({
			id: connection.id,
			channel: connection.channel,
			ownerUserId: `owner-${connection.id}`,
			enabled: true,
			status: 'logged_out',
			updatedAt: new Date().toISOString()
		});
		if (connection.credentials) await vault.put(connection.id, connection.credentials);
	}
	const shardHosts: FakeShardHost[] = [];
	const adapter = new OpenClawAdapter(config, state, vault, quietLogger(), {
		createShardHost: () => {
			const host = new FakeShardHost();
			shardHosts.push(host);
			return host;
		},
		...(options.startWeixinLogin ? { startWeixinLogin: options.startWeixinLogin } : {})
	});
	return { dataDir, state, vault, adapter, shardHosts };
}

test('shard assignment fills a shard to capacity before opening the next one', () => {
	const snapshot = (id: string, shardId?: string): ConnectionSnapshot => ({
		id,
		channel: 'wechat',
		enabled: true,
		status: 'connected',
		updatedAt: new Date().toISOString(),
		...(shardId ? { shardId } : {})
	});
	assert.equal(assignShard('wechat', [], 2), shardIdFor('wechat', 0));
	assert.equal(
		assignShard('wechat', [snapshot('a', 'wechat-shard-000')], 2),
		'wechat-shard-000'
	);
	assert.equal(
		assignShard(
			'wechat',
			[snapshot('a', 'wechat-shard-000'), snapshot('b', 'wechat-shard-000')],
			2
		),
		'wechat-shard-001'
	);
	// Channels never share shard slots with each other.
	assert.equal(
		assignShard('qq', [snapshot('a', 'wechat-shard-000'), snapshot('b', 'wechat-shard-000')], 2),
		'qq-shard-000'
	);
});

test('two WeChat accounts restore onto one shared shard process with account routing keys', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat', credentials: { accountId: 'wx-beta', botToken: 't2' } }
		]
	});
	await fixture.adapter.start();
	try {
		assert.equal(fixture.shardHosts.length, 1);
		const host = fixture.shardHosts[0]!;
		assert.equal(host.startCount, 1);
		assert.equal(host.shardId, 'wechat-shard-000');
		assert.deepEqual(
			host.members.map((member) => member.connectionId).sort(),
			['bot-wechat-u1', 'bot-wechat-u2']
		);
		const first = fixture.state.getConnection('bot-wechat-u1');
		const second = fixture.state.getConnection('bot-wechat-u2');
		assert.equal(first?.shardId, 'wechat-shard-000');
		assert.equal(second?.shardId, 'wechat-shard-000');
		assert.equal(first?.accountKey, await normalizeWeixinAccountKey('wx-alpha'));
		assert.equal(second?.accountKey, await normalizeWeixinAccountKey('wx-beta'));
		assert.equal(first?.status, 'connected');
		assert.equal(second?.status, 'connected');
		assert.equal(fixture.adapter.health().ready, true);
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('shard capacity overflow opens a second shard', async () => {
	const fixture = await sharedFixture({
		capacity: 1,
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat', credentials: { accountId: 'wx-beta', botToken: 't2' } }
		]
	});
	await fixture.adapter.start();
	try {
		assert.equal(fixture.shardHosts.length, 2);
		const shardIds = new Set(
			['bot-wechat-u1', 'bot-wechat-u2'].map((id) => fixture.state.getConnection(id)?.shardId)
		);
		assert.deepEqual([...shardIds].sort(), ['wechat-shard-000', 'wechat-shard-001']);
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('QQ shard members are keyed by connection id so events carry the owning connection', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-qq-u1', channel: 'qq', credentials: { app_id: 'app-1', app_secret: 'secret-1' } },
			{ id: 'bot-qq-u2', channel: 'qq', credentials: { app_id: 'app-2', app_secret: 'secret-2' } }
		]
	});
	await fixture.adapter.start();
	try {
		const host = fixture.shardHosts[0]!;
		assert.equal(host.channel, 'qq');
		const byConnection = new Map(host.members.map((member) => [member.connectionId, member]));
		assert.equal(byConnection.get('bot-qq-u1')?.qq?.appId, 'app-1');
		assert.equal(byConnection.get('bot-qq-u2')?.qq?.appId, 'app-2');
		assert.equal(fixture.state.getConnection('bot-qq-u1')?.accountKey, 'bot-qq-u1');
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('logging out one member keeps the sibling account served and frees the slot', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat', credentials: { accountId: 'wx-beta', botToken: 't2' } }
		]
	});
	await fixture.adapter.start();
	try {
		const host = fixture.shardHosts[0]!;
		const loggedOut = await fixture.adapter.logout('bot-wechat-u1');
		assert.equal(loggedOut.status, 'logged_out');
		assert.equal(loggedOut.shardId, undefined);
		assert.equal(loggedOut.accountKey, undefined);
		assert.equal(await fixture.vault.get('bot-wechat-u1'), undefined);
		assert.deepEqual(
			host.members.map((member) => member.connectionId),
			['bot-wechat-u2']
		);
		assert.equal(host.running, true);
		assert.equal(fixture.state.getConnection('bot-wechat-u2')?.status, 'connected');
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('deleting one member resyncs the shard without stopping it for the sibling', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat', credentials: { accountId: 'wx-beta', botToken: 't2' } }
		]
	});
	await fixture.adapter.start();
	try {
		const host = fixture.shardHosts[0]!;
		await fixture.adapter.deleteConnection('bot-wechat-u1');
		assert.equal(fixture.state.getConnection('bot-wechat-u1'), undefined);
		assert.deepEqual(
			host.members.map((member) => member.connectionId),
			['bot-wechat-u2']
		);
		assert.equal(host.running, true);
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('duplicate stored credentials restore only one member and stay quarantined', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't2' } }
		]
	});
	await fixture.adapter.start();
	try {
		const host = fixture.shardHosts[0]!;
		assert.deepEqual(
			host.members.map((member) => member.connectionId),
			['bot-wechat-u1']
		);
		assert.equal(fixture.state.getConnection('bot-wechat-u2')?.status, 'unavailable');
		// The supervisor must not resurrect the quarantined duplicate.
		(fixture.adapter as unknown as { superviseRuntimes(): void }).superviseRuntimes();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(
			host.members.map((member) => member.connectionId),
			['bot-wechat-u1']
		);
		assert.equal(fixture.state.getConnection('bot-wechat-u2')?.status, 'unavailable');
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('a bot account already bound to another connection is rejected at QR completion', async () => {
	let resolveCredential!: (credential: WeixinLoginCredential) => void;
	const completion = new Promise<WeixinLoginCredential>((resolve) => {
		resolveCredential = resolve;
	});
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-wechat-u2', channel: 'wechat' }
		],
		startWeixinLogin: async () => ({
			qrCode: {
				connectionId: 'bot-wechat-u2',
				dataUrl: 'data:image/png;base64,AA==',
				expiresAt: new Date(Date.now() + 60_000).toISOString()
			},
			completion,
			cancel: () => undefined
		})
	});
	await fixture.adapter.start();
	try {
		const awaiting = await fixture.adapter.login('bot-wechat-u2', {});
		assert.equal(awaiting.status, 'awaiting_scan');
		resolveCredential({ accountId: 'wx-alpha', botToken: 'stolen-token' });
		await waitFor(
			() => fixture.state.getConnection('bot-wechat-u2')?.status === 'logged_out'
		);
		assert.match(
			fixture.state.getConnection('bot-wechat-u2')?.detail || '',
			/already bound/
		);
		assert.equal(await fixture.vault.get('bot-wechat-u2'), undefined);
		// The original binding keeps its account untouched.
		assert.equal(
			fixture.state.getConnection('bot-wechat-u1')?.accountKey,
			await normalizeWeixinAccountKey('wx-alpha')
		);
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('a duplicate QQ app id is rejected when saving credentials', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-qq-u1', channel: 'qq', credentials: { app_id: 'app-1', app_secret: 'secret-1' } },
			{ id: 'bot-qq-u2', channel: 'qq' }
		]
	});
	await fixture.adapter.start();
	try {
		await assert.rejects(
			fixture.adapter.login('bot-qq-u2', {
				credentials: { app_id: 'app-1', app_secret: 'secret-other' }
			}),
			/account_already_bound/
		);
		assert.equal(await fixture.vault.get('bot-qq-u2'), undefined);
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('the supervisor restarts a crashed shard and only its members degrade', async () => {
	const fixture = await sharedFixture({
		connections: [
			{ id: 'bot-wechat-u1', channel: 'wechat', credentials: { accountId: 'wx-alpha', botToken: 't1' } },
			{ id: 'bot-qq-u1', channel: 'qq', credentials: { app_id: 'app-1', app_secret: 'secret-1' } }
		]
	});
	await fixture.adapter.start();
	try {
		assert.equal(fixture.shardHosts.length, 2);
		const wechatShard = fixture.shardHosts.find((host) => host.channel === 'wechat')!;
		const qqShard = fixture.shardHosts.find((host) => host.channel === 'qq')!;
		wechatShard.running = false;

		(fixture.adapter as unknown as { superviseRuntimes(): void }).superviseRuntimes();
		await waitFor(() => wechatShard.running);
		await waitFor(() => fixture.state.getConnection('bot-wechat-u1')?.status === 'connected');
		assert.equal(qqShard.running, true);
		assert.equal(fixture.state.getConnection('bot-qq-u1')?.status, 'connected');
	} finally {
		await fixture.adapter.stop();
		await rm(fixture.dataDir, { recursive: true, force: true });
	}
});

test('shared-shard normalization requires an account id and stamps routing metadata', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir);
	const previous = process.env.BOT_GATEWAY_OPENCLAW_SHARD_ID;
	process.env.BOT_GATEWAY_OPENCLAW_SHARD_ID = 'wechat-shard-000';
	try {
		const event = await normalizeMessageHook(
			{
				content: 'hello',
				channel: 'wechat',
				accountId: 'wx-alpha',
				conversationId: 'peer-1',
				senderId: 'peer-1',
				isGroup: false
			},
			{},
			config
		);
		assert.equal(event.connectionId, 'shard:wechat-shard-000');
		assert.equal(event.accountKey, 'wx-alpha');
		assert.equal(event.shardId, 'wechat-shard-000');

		await assert.rejects(
			normalizeMessageHook(
				{
					content: 'hello',
					channel: 'wechat',
					conversationId: 'peer-1',
					senderId: 'peer-1',
					isGroup: false
				},
				{},
				config
			),
			/account id is required/
		);
	} finally {
		if (previous === undefined) delete process.env.BOT_GATEWAY_OPENCLAW_SHARD_ID;
		else process.env.BOT_GATEWAY_OPENCLAW_SHARD_ID = previous;
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('the control server resolves shard events authoritatively and rejects cross-shard claims', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, {
		adapterMode: 'openclaw',
		openClawTopology: 'shared'
	});
	const seenEvents: GatewayInboundEvent[] = [];
	const runtime = await createRuntime(config, {
		transport: {
			async send(event) {
				seenEvents.push(structuredClone(event));
				return { text: 'routed reply' };
			}
		},
		logger: quietLogger()
	});
	assert.equal(runtime.enabled, true);
	if (!runtime.enabled) throw new Error('expected enabled runtime');
	const port = await runtime.start();
	const origin = `http://127.0.0.1:${port}`;
	try {
		await runtime.state.upsertConnection({
			id: 'bot-wechat-u1',
			channel: 'wechat',
			ownerUserId: 'user-1',
			enabled: true,
			status: 'connected',
			accountKey: 'wx-alpha',
			shardId: 'wechat-shard-000',
			updatedAt: new Date().toISOString()
		});

		const shardSecret = deriveShardBridgeSecret(config.hmacSecret, 'wechat-shard-000');
		const postShardEvent = async (
			event: GatewayInboundEvent,
			secret: string,
			shardHeader?: string
		): Promise<Response> => {
			const multipart = buildEventMultipart(event);
			const signed = signRequest(secret, {
				method: 'POST',
				pathWithQuery: config.bridgePath,
				body: multipart.body
			});
			return fetch(`${origin}${config.bridgePath}`, {
				method: 'POST',
				headers: {
					...signed,
					'content-type': multipart.contentType,
					...(shardHeader ? { 'x-ryanai-shard-id': shardHeader } : {})
				},
				body: Uint8Array.from(multipart.body)
			});
		};

		const shardEvent = inboundEvent({
			eventId: 'shard-event-1',
			connectionId: 'shard:wechat-shard-000',
			accountKey: 'wx-alpha',
			shardId: 'wechat-shard-000'
		});
		const resolved = await postShardEvent(shardEvent, shardSecret, 'wechat-shard-000');
		assert.equal(resolved.status, 200);
		const resolvedReply = (await resolved.json()) as { reply: { chunks: string[] } };
		assert.equal(resolvedReply.reply.chunks.join(''), 'routed reply');
		assert.equal(seenEvents.length, 1);
		assert.equal(seenEvents[0]!.connectionId, 'bot-wechat-u1');
		assert.equal(seenEvents[0]!.accountKey, undefined);
		assert.equal(seenEvents[0]!.shardId, undefined);

		// A shard signing correctly for itself cannot claim another shard's account.
		const foreignSecret = deriveShardBridgeSecret(config.hmacSecret, 'wechat-shard-001');
		const stolen = await postShardEvent(
			inboundEvent({
				eventId: 'shard-event-2',
				connectionId: 'shard:wechat-shard-001',
				accountKey: 'wx-alpha',
				shardId: 'wechat-shard-001'
			}),
			foreignSecret,
			'wechat-shard-001'
		);
		assert.equal(stolen.status, 200);
		assert.deepEqual(((await stolen.json()) as { reply: { chunks: string[] } }).reply.chunks, []);
		assert.equal(seenEvents.length, 1);

		// Claiming a shard in the header while signing with another key fails auth.
		const forged = await postShardEvent(
			inboundEvent({
				eventId: 'shard-event-3',
				connectionId: 'shard:wechat-shard-000',
				accountKey: 'wx-alpha',
				shardId: 'wechat-shard-000'
			}),
			foreignSecret,
			'wechat-shard-000'
		);
		assert.equal(forged.status, 401);

		// Shard routing metadata without the shard header is rejected outright.
		const inconsistent = await postShardEvent(
			inboundEvent({
				eventId: 'shard-event-4',
				connectionId: 'shard:wechat-shard-000',
				accountKey: 'wx-alpha',
				shardId: 'wechat-shard-000'
			}),
			config.bridgeHmacSecret
		);
		assert.equal(inconsistent.status, 400);
	} finally {
		await runtime.stop();
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('a shard host writes the multi-account QQ config and shard child environment', async () => {
	const dataDir = await tempDataDir();
	const config = testConfig(dataDir, { adapterMode: 'openclaw' });
	const host = new OpenClawHost(config, quietLogger());
	const internals = host as unknown as {
		shard?: { shardId: string; channel: Channel; members: OpenClawShardMember[] };
		channelEnabled: Record<Channel, boolean>;
		packageRoots?: Record<string, { root: string; version: string }>;
		writeConfig(): Promise<void>;
		childEnvironment(): NodeJS.ProcessEnv;
	};
	internals.shard = {
		shardId: 'qq-shard-000',
		channel: 'qq',
		members: [
			{ connectionId: 'bot-qq-u1', qq: { appId: 'app-1', appSecret: 'secret-1' } },
			{ connectionId: 'bot-qq-u2', qq: { appId: 'app-2', appSecret: 'secret-2' } }
		]
	};
	internals.channelEnabled = { wechat: false, qq: true };
	internals.packageRoots = {
		openclaw: { root: '/openclaw', version: 'test' },
		'@tencent-weixin/openclaw-weixin': { root: '/weixin', version: 'test' },
		'@tencent-connect/openclaw-qqbot': { root: '/qqbot', version: 'test' }
	};

	await internals.writeConfig();
	const written = JSON.parse(await readFile(host.configPath, 'utf8')) as {
		plugins: {
			allow: string[];
			load: { paths: string[] };
			entries: Record<string, { enabled: boolean }>;
		};
		channels: { qqbot: { enabled: boolean; appId?: string; accounts: Record<string, { appId: string; clientSecret: string; enabled: boolean }> } };
	};
	assert.deepEqual(written.plugins.allow, ['openclaw-qqbot', 'ryanai-bridge']);
	assert.equal(written.plugins.load.paths[0], '/qqbot');
	assert.equal(written.plugins.load.paths.includes('/weixin'), false);
	assert.equal(written.plugins.load.paths.length, 2);
	assert.equal(written.plugins.entries['openclaw-weixin']?.enabled, false);
	assert.equal(written.plugins.entries['openclaw-qqbot']?.enabled, true);
	assert.equal(written.channels.qqbot.enabled, true);
	assert.equal(written.channels.qqbot.appId, undefined);
	assert.deepEqual(Object.keys(written.channels.qqbot.accounts).sort(), ['bot-qq-u1', 'bot-qq-u2']);
	assert.equal(written.channels.qqbot.accounts['bot-qq-u1']!.appId, 'app-1');
	assert.equal(written.channels.qqbot.accounts['bot-qq-u2']!.clientSecret, 'secret-2');

	const env = internals.childEnvironment();
	assert.equal(env.BOT_GATEWAY_OPENCLAW_SHARD_ID, 'qq-shard-000');
	assert.equal(env.BOT_GATEWAY_OPENCLAW_CONNECTION_ID, undefined);
	assert.equal(env.QQBOT_APP_ID, undefined);
	assert.equal(env.QQBOT_CLIENT_SECRET, undefined);
	assert.equal(
		env.BOT_GATEWAY_HMAC_SECRET,
		deriveShardBridgeSecret(config.hmacSecret, 'qq-shard-000')
	);
	await rm(dataDir, { recursive: true, force: true });
});

test('a WeChat shard materializes every member credential and clears stale accounts', async () => {
	const dataDir = await tempDataDir();
	const stateDir = path.join(dataDir, 'shard-state');
	const config = testConfig(dataDir, { adapterMode: 'openclaw', openClawStateDir: stateDir });
	const host = new OpenClawHost(config, quietLogger());
	const internals = host as unknown as {
		materializeWeixinShardCredentials(members: readonly OpenClawShardMember[]): Promise<void>;
	};
	const staleDir = path.join(stateDir, 'openclaw-weixin');
	await mkdir(path.join(staleDir, 'accounts'), { recursive: true });
	await writeFile(path.join(staleDir, 'accounts.json'), JSON.stringify(['stale-account']));
	await writeFile(path.join(staleDir, 'accounts', 'stale-account.json'), '{"token":"stale"}');

	await withOpenClawEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
		internals.materializeWeixinShardCredentials([
			{ connectionId: 'bot-wechat-u1', wechat: { accountId: 'wx-alpha', botToken: 't1' } },
			{ connectionId: 'bot-wechat-u2', wechat: { accountId: 'wx-beta', botToken: 't2' } }
		])
	);

	const registered = JSON.parse(
		await readFile(path.join(staleDir, 'accounts.json'), 'utf8')
	) as string[];
	const keys = await Promise.all(
		['wx-alpha', 'wx-beta'].map((id) => normalizeWeixinAccountKey(id))
	);
	assert.deepEqual([...registered].sort(), [...keys].sort());
	for (const key of keys) {
		const account = JSON.parse(
			await readFile(path.join(staleDir, 'accounts', `${key}.json`), 'utf8')
		) as { token: string };
		assert.ok(account.token);
	}
	await assert.rejects(readFile(path.join(staleDir, 'accounts', 'stale-account.json'), 'utf8'));
	await rm(dataDir, { recursive: true, force: true });
});

test('isolated WeChat account state migrates into the shard tree without clobbering', async () => {
	const dataDir = await tempDataDir();
	const isolatedStateDir = path.join(dataDir, 'openclaw-state', 'bot-wechat-u1', 'state');
	const shardStateDir = path.join(dataDir, 'openclaw-state', 'shards', 'wechat-shard-000', 'state');
	const accountsDir = path.join(isolatedStateDir, 'openclaw-weixin', 'accounts');
	await mkdir(accountsDir, { recursive: true });
	await writeFile(path.join(accountsDir, 'wx-alpha.json'), '{"token":"t1"}');
	await writeFile(path.join(accountsDir, 'wx-alpha.sync.json'), '{"cursor":42}');
	await writeFile(path.join(accountsDir, 'wx-other.json'), '{"token":"other"}');
	const credentialsDir = path.join(isolatedStateDir, 'credentials');
	await mkdir(credentialsDir, { recursive: true });
	await writeFile(
		path.join(credentialsDir, 'openclaw-weixin-wx-alpha-allowFrom.json'),
		'["friend"]'
	);
	const existingTarget = path.join(shardStateDir, 'openclaw-weixin', 'accounts');
	await mkdir(existingTarget, { recursive: true });
	await writeFile(path.join(existingTarget, 'wx-alpha.json'), '{"token":"newer"}');

	await migrateIsolatedWeixinState({
		isolatedStateDir,
		shardStateDir,
		accountIds: ['wx-alpha'],
		logger: quietLogger()
	});

	// Present files stay untouched; missing per-account files are copied; foreign
	// accounts are left behind.
	assert.equal(await readFile(path.join(existingTarget, 'wx-alpha.json'), 'utf8'), '{"token":"newer"}');
	assert.equal(
		await readFile(path.join(existingTarget, 'wx-alpha.sync.json'), 'utf8'),
		'{"cursor":42}'
	);
	await assert.rejects(readFile(path.join(existingTarget, 'wx-other.json'), 'utf8'));
	assert.equal(
		await readFile(
			path.join(shardStateDir, 'credentials', 'openclaw-weixin-wx-alpha-allowFrom.json'),
			'utf8'
		),
		'["friend"]'
	);
	await rm(dataDir, { recursive: true, force: true });
});
