export class KeyedSerialQueue {
	private readonly tails = new Map<string, Promise<void>>();
	private readonly depths = new Map<string, number>();

	constructor(
		private readonly maxDepthPerKey = 100,
		private readonly maxWaitMs = 0
	) {}

	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const depth = this.depths.get(key) || 0;
		if (depth >= this.maxDepthPerKey) throw new Error('queue_capacity_exceeded');
		this.depths.set(key, depth + 1);
		const previous = this.tails.get(key) || Promise.resolve();
		let release!: () => void;
		const marker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => marker);
		this.tails.set(key, tail);

		try {
			// Releasing the marker without running the task is safe: the next waiter
			// still awaits `previous`, so a timed-out entry drops out of the queue
			// without letting anything overtake the task that is still running.
			if (!(await this.awaitTurn(previous))) throw new Error('queue_wait_timeout');
			return await task();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
			const remaining = (this.depths.get(key) || 1) - 1;
			if (remaining <= 0) this.depths.delete(key);
			else this.depths.set(key, remaining);
		}
	}

	private async awaitTurn(previous: Promise<void>): Promise<boolean> {
		const settled = previous.then(
			() => true,
			() => true
		);
		if (this.maxWaitMs <= 0) return settled;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.maxWaitMs);
			timer.unref();
		});
		try {
			return await Promise.race([settled, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	get activeKeys(): number {
		return this.tails.size;
	}
}

export class QueueAdmissionError extends Error {
	constructor(readonly code: 'queue_overloaded' | 'queue_wait_timeout' | 'gateway_draining') {
		super(code);
		this.name = 'QueueAdmissionError';
	}
}

interface FairTask<T> {
	connectionId: string;
	bytes: number;
	enqueuedAt: number;
	task: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

export interface FairQueueSnapshot {
	accepting: boolean;
	active: number;
	queued: number;
	queuedBytes: number;
	activeByConnection: ReadonlyMap<string, number>;
	queuedByConnection: ReadonlyMap<string, number>;
}

export interface FairQueueLimits {
	maxGlobalActive: number;
	maxConnectionActive: number;
	maxGlobalQueued: number;
	maxConnectionQueued: number;
	maxQueuedBytes: number;
	maxWaitMs: number;
}

/**
 * Bounded round-robin scheduler. Each connection owns a FIFO and dispatch
 * rotates between non-empty connections, so a noisy account cannot consume
 * every newly available global slot.
 */
export class FairConnectionQueue {
	private accepting = true;
	private active = 0;
	private queued = 0;
	private queuedBytes = 0;
	private readonly activeByConnection = new Map<string, number>();
	private readonly queues = new Map<string, FairTask<unknown>[]>();
	private readonly rotation: string[] = [];
	private rotationIndex = 0;
	private readonly idleWaiters = new Set<() => void>();

	constructor(private readonly limits: FairQueueLimits) {}

	run<T>(connectionId: string, bytes: number, task: () => Promise<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new QueueAdmissionError('gateway_draining'));
		const connectionQueued = this.queues.get(connectionId)?.length ?? 0;
		const mustWait =
			this.active >= this.limits.maxGlobalActive ||
			(this.activeByConnection.get(connectionId) ?? 0) >= this.limits.maxConnectionActive ||
			this.queued > 0;
		if (
			mustWait && (
				this.queued >= this.limits.maxGlobalQueued ||
				connectionQueued >= this.limits.maxConnectionQueued ||
				this.queuedBytes + bytes > this.limits.maxQueuedBytes
			)
		) {
			return Promise.reject(new QueueAdmissionError('queue_overloaded'));
		}

		return new Promise<T>((resolve, reject) => {
			const entry: FairTask<T> = {
				connectionId,
				bytes,
				enqueuedAt: Date.now(),
				task,
				resolve,
				reject
			};
			let queue = this.queues.get(connectionId);
			if (!queue) {
				queue = [];
				this.queues.set(connectionId, queue);
				this.rotation.push(connectionId);
			}
			queue.push(entry as FairTask<unknown>);
			this.queued += 1;
			this.queuedBytes += bytes;
			entry.timer = setTimeout(() => this.expire(entry as FairTask<unknown>), this.limits.maxWaitMs);
			entry.timer.unref();
			this.drain();
		});
	}

	stopAccepting(): void {
		this.accepting = false;
		this.checkIdle();
	}

	async waitForIdle(timeoutMs: number): Promise<boolean> {
		if (this.active === 0 && this.queued === 0) return true;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				this.idleWaiters.delete(onIdle);
				if (timer) clearTimeout(timer);
				resolve(value);
			};
			const onIdle = () => finish(true);
			this.idleWaiters.add(onIdle);
			const timer = timeoutMs > 0 ? setTimeout(() => finish(false), timeoutMs) : undefined;
			timer?.unref();
		});
	}

	cancelQueued(): void {
		for (const queue of this.queues.values()) {
			for (const entry of queue) {
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new QueueAdmissionError('gateway_draining'));
			}
		}
		this.queues.clear();
		this.rotation.length = 0;
		this.rotationIndex = 0;
		this.queued = 0;
		this.queuedBytes = 0;
		this.checkIdle();
	}

	snapshot(): FairQueueSnapshot {
		return {
			accepting: this.accepting,
			active: this.active,
			queued: this.queued,
			queuedBytes: this.queuedBytes,
			activeByConnection: new Map(this.activeByConnection),
			queuedByConnection: new Map(
				[...this.queues].map(([connectionId, queue]) => [connectionId, queue.length])
			)
		};
	}

	private drain(): void {
		while (this.active < this.limits.maxGlobalActive && this.queued > 0) {
			const entry = this.nextEligible();
			if (!entry) return;
			if (entry.timer) clearTimeout(entry.timer);
			this.queued -= 1;
			this.queuedBytes -= entry.bytes;
			this.active += 1;
			this.activeByConnection.set(
				entry.connectionId,
				(this.activeByConnection.get(entry.connectionId) ?? 0) + 1
			);
			void entry.task().then(entry.resolve, entry.reject).finally(() => {
				this.active -= 1;
				const remaining = (this.activeByConnection.get(entry.connectionId) ?? 1) - 1;
				if (remaining <= 0) this.activeByConnection.delete(entry.connectionId);
				else this.activeByConnection.set(entry.connectionId, remaining);
				this.drain();
				this.checkIdle();
			});
		}
	}

	private nextEligible(): FairTask<unknown> | undefined {
		if (this.rotation.length === 0) return undefined;
		for (let checked = 0; checked < this.rotation.length; checked += 1) {
			if (this.rotationIndex >= this.rotation.length) this.rotationIndex = 0;
			const connectionId = this.rotation[this.rotationIndex]!;
			this.rotationIndex = (this.rotationIndex + 1) % this.rotation.length;
			if ((this.activeByConnection.get(connectionId) ?? 0) >= this.limits.maxConnectionActive) {
				continue;
			}
			const queue = this.queues.get(connectionId);
			const entry = queue?.shift();
			if (!entry) {
				this.removeRotation(connectionId);
				checked -= 1;
				continue;
			}
			if (queue!.length === 0) this.removeRotation(connectionId);
			return entry;
		}
		return undefined;
	}

	private expire(target: FairTask<unknown>): void {
		const queue = this.queues.get(target.connectionId);
		const index = queue?.indexOf(target) ?? -1;
		if (!queue || index < 0) return;
		queue.splice(index, 1);
		this.queued -= 1;
		this.queuedBytes -= target.bytes;
		if (queue.length === 0) this.removeRotation(target.connectionId);
		target.reject(new QueueAdmissionError('queue_wait_timeout'));
		this.checkIdle();
	}

	private removeRotation(connectionId: string): void {
		this.queues.delete(connectionId);
		const index = this.rotation.indexOf(connectionId);
		if (index < 0) return;
		this.rotation.splice(index, 1);
		if (index < this.rotationIndex) this.rotationIndex -= 1;
		if (this.rotationIndex >= this.rotation.length) this.rotationIndex = 0;
	}

	private checkIdle(): void {
		if (this.active !== 0 || this.queued !== 0) return;
		for (const waiter of this.idleWaiters) waiter();
		this.idleWaiters.clear();
	}
}
