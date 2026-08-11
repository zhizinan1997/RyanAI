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
