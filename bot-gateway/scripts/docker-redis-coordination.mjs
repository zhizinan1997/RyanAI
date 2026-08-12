import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { createCoordinator } from '../dist/coordination.js';
import { Logger } from '../dist/logger.js';

const container = `ryanai-bot-gateway-redis-${process.pid}`;
const port = Number(process.env.BOT_GATEWAY_REDIS_TEST_PORT || 16379);
const redisUrl = `redis://127.0.0.1:${port}`;
const prefix = 'ryanai:bot-gateway:v1:{coord}';
const logger = new Logger('coordination-test', { write() {} });

function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function redis(...args) {
	return docker('exec', container, 'redis-cli', '--raw', ...args);
}

function backendScheduler(...shardIds) {
	const projectRoot = path.resolve('..');
	const python = path.join(projectRoot, '.venv', 'bin', 'python');
	const source = [
		'import asyncio, json',
		'from open_webui.utils.bot_gateway_coordination import ensure_shard_targets',
		`print(json.dumps(asyncio.run(ensure_shard_targets(${JSON.stringify(shardIds)})), sort_keys=True))`
	].join(';');
	return JSON.parse(execFileSync(python, ['-c', source], {
		cwd: projectRoot,
		encoding: 'utf8',
		env: {
			...process.env,
			PYTHONPATH: path.join(projectRoot, 'backend'),
			REDIS_URL: redisUrl,
			BOT_GATEWAY_COORDINATION_MODE: 'redis',
			WEBUI_SECRET_KEY: 'coordination-test-secret-at-least-32-characters'
		}
	}).trim());
}

function config(nodeId) {
	return {
		coordinationMode: 'redis', redisUrl, nodeId,
		advertiseUrl: new URL(`http://${nodeId}:8787`),
		leaseTtlMs: 10_000,
	};
}

async function waitForRedis() {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			if (redis('PING') === 'PONG') return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error('Redis test container did not become ready');
}

docker('run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine');
const nodeA = createCoordinator(config('node-a'), logger);
const nodeB = createCoordinator(config('node-b'), logger);
try {
	await waitForRedis();
	await Promise.all([nodeA.start(), nodeB.start()]);
	const shardId = 'qq-shard-000';
	const targetKey = `${prefix}:shard:${shardId}:target`;

	assert.equal(await nodeA.acquire(shardId, 1), undefined, 'acquire must fail without a target');
	redis('SET', targetKey, 'node-a');
	const leaseA = await nodeA.acquire(shardId, 1);
	assert.ok(leaseA, 'target node must acquire the lease');
	assert.equal(await nodeB.acquire(shardId, 1), undefined, 'non-target node must not acquire');

	redis('SET', targetKey, 'node-b');
	assert.equal(await nodeA.renew(leaseA), false, 'old owner must fail renewal after target moves');
	assert.equal(await nodeB.acquire(shardId, 2), undefined, 'new target waits for the old lease to release or expire');
	assert.equal(await nodeA.release({ ...leaseA, value: `${leaseA.value}-stale` }), false, 'stale release must fail');
	assert.equal(await nodeA.release(leaseA), true, 'current owner can release its exact lease');

	const leaseB = await nodeB.acquire(shardId, 2);
	assert.ok(leaseB, 'new target acquires after handoff');
	assert.ok(leaseB.epoch > leaseA.epoch, 'fencing epoch must increase');
	await nodeB.release(leaseB);

	await nodeB.setDraining(true);
	assert.equal(await nodeB.acquire(shardId, 3), undefined, 'draining node must not acquire');
	await nodeB.setDraining(false);
	const resumed = await nodeB.acquire(shardId, 3);
	assert.ok(resumed, 'resumed target can acquire again');
	await nodeB.release(resumed);

	redis('DEL', targetKey);
	redis('PSETEX', `${prefix}:node:node-a:heartbeat`, '30000', JSON.stringify({
		nodeId: 'node-a', cpuPercent: 2, rssBytes: 64 * 1024 * 1024,
		queue: { active: 0, queued: 0 }, operations: { shards: [] }
	}));
	redis('PSETEX', `${prefix}:node:node-b:heartbeat`, '30000', JSON.stringify({
		nodeId: 'node-b', cpuPercent: 80, rssBytes: 1024 * 1024 * 1024,
		queue: { active: 8, queued: 20 }, operations: { shards: [] }
	}));
	const scheduled = backendScheduler(shardId, 'qq-shard-001');
	assert.deepEqual(scheduled, {
		'qq-shard-000': 'node-a',
		'qq-shard-001': 'node-a'
	}, 'backend leader scheduler must select the lowest-load heartbeat');
	assert.deepEqual(
		backendScheduler(shardId, 'qq-shard-001'),
		scheduled,
		'backend targets must remain sticky'
	);

	console.log(JSON.stringify({
		ok: true,
		checks: [
			'no_target_rejected', 'target_acquired', 'target_move_fenced_old_owner',
			'stale_release_rejected', 'drain_blocked_acquire', 'epoch_increased',
			'leader_selected_lowest_load_node', 'targets_remained_sticky'
		]
	}, null, 2));
} finally {
	await Promise.allSettled([nodeA.stop(), nodeB.stop()]);
	try { docker('rm', '-f', container); } catch {}
}
