import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { buildEventMultipart } from '../dist/ryanai-client.js';
import { deriveShardBridgeSecret } from '../dist/config.js';
import { signRequest } from '../dist/security/hmac.js';

const IMAGE = process.env.BOT_GATEWAY_BENCHMARK_IMAGE || 'ryanai-bot-gateway:shard-test';
const SECRET = 'test-hmac-secret-0123456789abcdef0123456789abcdef';
const KEY = '07'.repeat(32);
const counts = process.argv.includes('--matrix') ? [1, 2, 4, 8, 12] : [2];
const outputDir = path.resolve(process.env.BOT_GATEWAY_BENCHMARK_OUTPUT || 'benchmark-results');

function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function memoryBytes(value) {
	const match = /^([0-9.]+)([KMG]iB)$/.exec(value.trim());
	if (!match) return 0;
	return Math.round(Number(match[1]) * ({ KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 })[match[2]]);
}

async function signedRequest(origin, method, requestPath, payload) {
	const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
	const response = await fetch(`${origin}${requestPath}`, {
		method,
		headers: {
			...signRequest(SECRET, { method, pathWithQuery: requestPath, body }),
			...(payload === undefined ? {} : { 'content-type': 'application/json' })
		},
		...(payload === undefined ? {} : { body })
	});
	const text = await response.text();
	let json;
	try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
	return { status: response.status, text, json };
}

async function waitFor(predicate, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	do {
		const result = await predicate();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`);
}

function openClawPids(container) {
	const output = docker('top', container, '-eo', 'pid,args');
	return output.split('\n').slice(1).flatMap((line) => {
		const match = /^\s*(\d+)\s+.*openclaw-gateway(?:\s|$)/.exec(line);
		return match ? [Number(match[1])] : [];
	});
}

function killOpenClaw(container) {
	const program = [
		"const fs=require('fs')",
		"for(const name of fs.readdirSync('/proc')){",
		"if(!/^\\d+$/.test(name)||name==='1')continue",
		"try{const cmd=fs.readFileSync('/proc/'+name+'/cmdline','utf8')",
		"if(cmd.includes('openclaw-gateway')){process.kill(Number(name),'SIGKILL');process.exit(0)}}catch{}}",
		"process.exit(1)"
	].join(';');
	docker('exec', container, 'node', '-e', program);
}

async function createAccount(origin, index) {
	const id = `qq-bench-${index}`;
	const appId = `invalid-benchmark-app-${index}`;
	let response = await signedRequest(origin, 'POST', '/v1/connections', {
		channel: 'qq', owner_user_id: `benchmark-owner-${index}`, connection_id: id
	});
	if (response.status !== 201) throw new Error(`create ${id}: ${response.status} ${response.text}`);
	response = await signedRequest(origin, 'PUT', `/v1/connections/${id}/credentials`, {
		app_id: appId, app_secret: `invalid-benchmark-secret-${index}`
	});
	if (response.status !== 204) throw new Error(`credentials ${id}: ${response.status} ${response.text}`);
	response = await signedRequest(origin, 'POST', `/v1/connections/${id}/login`, {});
	if (response.status !== 200) throw new Error(`login ${id}: ${response.status} ${response.text}`);
	return { id, appId };
}

async function postBridgeEvent(origin, shardId, connectionId, secret) {
	const event = {
		eventId: `benchmark-${Date.now()}-${Math.random()}`,
		occurredAt: Date.now(), channel: 'qq', connectionId: `shard:${shardId}`,
		accountKey: connectionId, shardId,
		conversation: { type: 'private', id: 'benchmark-peer' }, sender: { id: 'benchmark-peer' },
		message: { text: 'benchmark', mentionsBot: true }, attachments: []
	};
	const multipart = buildEventMultipart(event);
	const response = await fetch(`${origin}/v1/openclaw/events`, {
		method: 'POST',
		headers: {
			...signRequest(secret, { method: 'POST', pathWithQuery: '/v1/openclaw/events', body: multipart.body }),
			'content-type': multipart.contentType,
			'x-ryanai-shard-id': shardId,
			'x-ryanai-event-id': event.eventId
		},
		body: multipart.body
	});
	return { status: response.status, json: await response.json().catch(() => undefined) };
}

async function bridgeAssertions(origin, connectionId) {
	const local = await postBridgeEvent(
		origin, 'qq-shard-000', connectionId, deriveShardBridgeSecret(SECRET, 'qq-shard-000')
	);
	const cross = await postBridgeEvent(
		origin, 'qq-shard-001', connectionId, deriveShardBridgeSecret(SECRET, 'qq-shard-001')
	);
	const forged = await postBridgeEvent(
		origin, 'qq-shard-000', connectionId, deriveShardBridgeSecret(SECRET, 'qq-shard-001')
	);
	return {
		local_safe_error: local.status === 200 && local.json?.reply?.reason === 'safe-error',
		cross_shard_ignored: cross.status === 200 && cross.json?.reply?.reason === 'ignored',
		forged_rejected: forged.status === 401
	};
}

async function runCase(topology, accountCount, port) {
	const container = `ryanai-shard-bench-${topology}-${accountCount}-${process.pid}`;
	const origin = `http://127.0.0.1:${port}`;
	try {
		docker('run', '-d', '--name', container, '-p', `127.0.0.1:${port}:8787`,
			'-e', 'BOT_GATEWAY_ENABLED=true', '-e', 'BOT_GATEWAY_ADAPTER=openclaw',
			'-e', `BOT_GATEWAY_OPENCLAW_TOPOLOGY=${topology}`, '-e', `BOT_GATEWAY_HMAC_SECRET=${SECRET}`,
			'-e', `BOT_GATEWAY_CREDENTIALS_ENCRYPTION_KEY=${KEY}`, IMAGE);
		await waitFor(async () => (await fetch(`${origin}/health`).catch(() => undefined))?.ok, 30_000, 'gateway health');
		const accounts = [];
		for (let index = 0; index < accountCount; index += 1) accounts.push(await createAccount(origin, index));
		const expectedProcesses = topology === 'shared' ? 1 : accountCount;
		const pids = await waitFor(() => {
			const current = openClawPids(container);
			return current.length === expectedProcesses ? current : undefined;
		}, 20_000, `${expectedProcesses} OpenClaw processes`);
		const listed = await signedRequest(origin, 'GET', '/v1/connections');
		const connections = listed.json?.connections || [];
		const stats = JSON.parse(docker('stats', '--no-stream', '--format', '{{json .}}', container));
		let bridge;
		let duplicateRejected;
		let recoveryMs;
		if (topology === 'shared') {
			bridge = await bridgeAssertions(origin, accounts[0].id);
			if (accountCount >= 2) {
				await signedRequest(origin, 'PUT', `/v1/connections/${accounts[1].id}/credentials`, {
					app_id: accounts[0].appId, app_secret: 'duplicate-secret'
				});
				const duplicate = await signedRequest(origin, 'POST', `/v1/connections/${accounts[1].id}/login`, {});
				duplicateRejected = duplicate.status === 409;
			}
			const oldPid = pids[0];
			const started = Date.now();
			killOpenClaw(container);
			await waitFor(() => {
				const current = openClawPids(container);
				return current.length === 1 && current[0] !== oldPid ? current[0] : undefined;
			}, 15_000, 'OpenClaw supervisor recovery');
			recoveryMs = Date.now() - started;
		}
		return {
			topology, account_count: accountCount, process_count: pids.length,
			memory_bytes: memoryBytes(stats.MemUsage.split('/')[0]), memory_usage: stats.MemUsage,
			connections_valid: connections.length === accountCount && connections.every((item) =>
				item.id && (topology !== 'shared' || (item.accountKey && item.shardId === 'qq-shard-000'))),
			...(bridge ? { bridge } : {}),
			...(duplicateRejected !== undefined ? { duplicate_account_rejected: duplicateRejected } : {}),
			...(recoveryMs !== undefined ? { recovery_ms: recoveryMs, recovered_within_15s: recoveryMs <= 15_000 } : {})
		};
	} finally {
		try { docker('rm', '-f', container); } catch {}
	}
}

await mkdir(outputDir, { recursive: true });
const imageId = docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
const results = [];
for (const count of counts) {
	results.push(await runCase('shared', count, 18787));
	results.push(await runCase('isolated', count, 18788));
}
const comparisons = counts.map((count) => {
	const shared = results.find((item) => item.topology === 'shared' && item.account_count === count);
	const isolated = results.find((item) => item.topology === 'isolated' && item.account_count === count);
	return {
		account_count: count,
		memory_saving_percent: isolated.memory_bytes > 0
			? Number(((1 - shared.memory_bytes / isolated.memory_bytes) * 100).toFixed(2)) : 0
	};
});
const report = {
	generated_at: new Date().toISOString(), image: IMAGE, image_id: imageId,
	docker_version: docker('version', '--format', '{{.Server.Version}}'), results, comparisons
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(outputDir, `bot-gateway-benchmark-${stamp}.json`);
const mdPath = path.join(outputDir, `bot-gateway-benchmark-${stamp}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const rows = results.map((item) =>
	`| ${item.account_count} | ${item.topology} | ${item.process_count} | ${item.memory_usage} | ${item.recovery_ms ?? '-'} |`
);
await writeFile(mdPath, [
	'# Bot Gateway Docker Benchmark', '', `- Image: \`${IMAGE}\``, `- Image ID: \`${imageId}\``,
	`- Generated: ${report.generated_at}`, '', '| Accounts | Topology | Processes | Memory | Recovery ms |',
	'| ---: | --- | ---: | --- | ---: |', ...rows, '',
	...comparisons.map((item) => `- ${item.account_count} account(s): shared memory saving ${item.memory_saving_percent}%`), ''
].join('\n'));
console.log(JSON.stringify({ json: jsonPath, markdown: mdPath, report }, null, 2));
