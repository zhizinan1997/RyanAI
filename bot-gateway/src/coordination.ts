import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';

import type { GatewayConfig } from './config.js';
import type { Logger } from './logger.js';

// Coordination Lua scripts touch node and shard keys atomically. A shared hash
// tag keeps those keys in one Redis Cluster slot and avoids CROSSSLOT failures.
const PREFIX = 'ryanai:bot-gateway:v1:{coord}';

export interface ShardLease {
	shardId: string;
	nodeId: string;
	leaseId: string;
	epoch: number;
	assignmentGeneration: number;
	expiresAt: number;
	value: string;
}

export interface GatewayCoordinator {
	readonly mode: 'single' | 'redis';
	start(): Promise<void>;
	stop(): Promise<void>;
	acquire(shardId: string, assignmentGeneration: number): Promise<ShardLease | undefined>;
	renew(lease: ShardLease): Promise<boolean>;
	release(lease: ShardLease): Promise<boolean>;
	current(shardId: string): Promise<ShardLease | undefined>;
	setDraining(draining: boolean): Promise<void>;
	setSnapshotProvider(provider: () => Promise<Record<string, unknown>>): void;
}

function leaseValue(nodeId: string, leaseId: string, epoch: number, generation: number): string {
	return JSON.stringify({ nodeId, leaseId, epoch, assignmentGeneration: generation });
}

function parseLease(shardId: string, value: string, ttl: number): ShardLease | undefined {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (
			typeof parsed.nodeId !== 'string' || typeof parsed.leaseId !== 'string' ||
			typeof parsed.epoch !== 'number' || typeof parsed.assignmentGeneration !== 'number'
		) return undefined;
		return {
			shardId, nodeId: parsed.nodeId, leaseId: parsed.leaseId,
			epoch: parsed.epoch, assignmentGeneration: parsed.assignmentGeneration,
			expiresAt: Date.now() + Math.max(0, ttl), value
		};
	} catch { return undefined; }
}

class SingleCoordinator implements GatewayCoordinator {
	readonly mode = 'single' as const;
	constructor(private readonly config: GatewayConfig) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async acquire(shardId: string, assignmentGeneration: number): Promise<ShardLease> {
		const value = leaseValue(this.config.nodeId, 'single', 0, assignmentGeneration);
		return { shardId, nodeId: this.config.nodeId, leaseId: 'single', epoch: 0,
			assignmentGeneration, expiresAt: Number.MAX_SAFE_INTEGER, value };
	}
	async renew(): Promise<boolean> { return true; }
	async release(): Promise<boolean> { return true; }
	async current(): Promise<ShardLease | undefined> { return undefined; }
	async setDraining(): Promise<void> {}
	setSnapshotProvider(): void {}
}

class RedisCoordinator implements GatewayCoordinator {
	readonly mode = 'redis' as const;
	private readonly client: RedisClientType;
	private heartbeat?: NodeJS.Timeout;
	private snapshotProvider?: () => Promise<Record<string, unknown>>;
	private lastCpuUsage = process.cpuUsage();
	private lastHeartbeatAt = Date.now();

	constructor(private readonly config: GatewayConfig, private readonly logger: Logger) {
		this.client = createClient({ url: config.redisUrl });
		this.client.on('error', (error) => this.logger.error('Redis coordination error', {
			error_message: error instanceof Error ? error.message : String(error)
		}));
	}

	async start(): Promise<void> {
		await this.client.connect();
		await this.writeHeartbeat();
		this.heartbeat = setInterval(() => void this.writeHeartbeat().catch(() => undefined), 10_000);
		this.heartbeat.unref();
	}

	async stop(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		if (this.client.isOpen) await this.client.quit();
	}

	async acquire(shardId: string, assignmentGeneration: number): Promise<ShardLease | undefined> {
		const leaseId = randomUUID();
		const result = await this.client.eval(
			`if redis.call('EXISTS', KEYS[3]) == 1 then return nil end
			 if redis.call('GET', KEYS[4]) ~= ARGV[1] then return nil end
			 if redis.call('EXISTS', KEYS[1]) == 1 then return nil end
			 local epoch=redis.call('INCR', KEYS[2])
			 local value=cjson.encode({nodeId=ARGV[1],leaseId=ARGV[2],epoch=epoch,assignmentGeneration=tonumber(ARGV[3])})
			 redis.call('PSETEX', KEYS[1], ARGV[4], value)
			 return {value,tostring(epoch)}`,
			{ keys: [this.leaseKey(shardId), `${PREFIX}:shard:${shardId}:epoch`, this.drainKey(), this.targetKey(shardId)],
				arguments: [this.config.nodeId, leaseId, String(assignmentGeneration), String(this.config.leaseTtlMs)] }
		) as string[] | null;
		if (!result) return undefined;
		return parseLease(shardId, result[0]!, this.config.leaseTtlMs);
	}

	async renew(lease: ShardLease): Promise<boolean> {
		const result = await this.client.eval(
				`if redis.call('GET',KEYS[1]) == ARGV[1] and redis.call('GET',KEYS[2]) == ARGV[3]
				 then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end`,
				{ keys: [this.leaseKey(lease.shardId), this.targetKey(lease.shardId)],
					arguments: [lease.value, String(this.config.leaseTtlMs), this.config.nodeId] }
		);
		if (Number(result) === 1) lease.expiresAt = Date.now() + this.config.leaseTtlMs;
		return Number(result) === 1;
	}

	async release(lease: ShardLease): Promise<boolean> {
		const result = await this.client.eval(
			`if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,
			{ keys: [this.leaseKey(lease.shardId)], arguments: [lease.value] }
		);
		return Number(result) === 1;
	}

	async current(shardId: string): Promise<ShardLease | undefined> {
		const [value, ttl] = await Promise.all([
			this.client.get(this.leaseKey(shardId)), this.client.pTTL(this.leaseKey(shardId))
		]);
		return value ? parseLease(shardId, value, ttl) : undefined;
	}

	async setDraining(draining: boolean): Promise<void> {
		const key = this.drainKey();
		if (draining) await this.client.set(key, '1'); else await this.client.del(key);
	}

	setSnapshotProvider(provider: () => Promise<Record<string, unknown>>): void {
		this.snapshotProvider = provider;
	}

	private leaseKey(shardId: string): string { return `${PREFIX}:shard:${shardId}:lease`; }
	private targetKey(shardId: string): string { return `${PREFIX}:shard:${shardId}:target`; }
	private drainKey(): string { return `${PREFIX}:node:${this.config.nodeId}:draining`; }
	private async writeHeartbeat(): Promise<void> {
		const now = Date.now();
		const usage = process.cpuUsage(this.lastCpuUsage);
		const elapsedMicros = Math.max(1, (now - this.lastHeartbeatAt) * 1_000);
		const cpuPercent = ((usage.user + usage.system) / elapsedMicros) * 100;
		this.lastCpuUsage = process.cpuUsage();
		this.lastHeartbeatAt = now;
		const runtime = await this.snapshotProvider?.().catch(() => ({})) ?? {};
		await this.client.set(`${PREFIX}:node:${this.config.nodeId}:heartbeat`, JSON.stringify({
			nodeId: this.config.nodeId, advertiseUrl: this.config.advertiseUrl?.toString(),
			pid: process.pid, version: process.env.npm_package_version || '0.1.0', at: now,
			cpuPercent, rssBytes: process.memoryUsage().rss, ...runtime
		}), { PX: 30_000 });
	}
}

export function createCoordinator(config: GatewayConfig, logger: Logger): GatewayCoordinator {
	return config.coordinationMode === 'redis'
		? new RedisCoordinator(config, logger.child('redis'))
		: new SingleCoordinator(config);
}
