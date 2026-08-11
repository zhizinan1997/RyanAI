type EnvOverrides = Record<string, string | undefined>;

let tail: Promise<void> = Promise.resolve();

/**
 * Run an operation with OpenClaw's process-wide environment pointed at one
 * connection.
 *
 * The pinned WeChat and login packages read `OPENCLAW_STATE_DIR` /
 * `OPENCLAW_CONFIG_PATH` from `process.env` at call time, so two connections
 * materializing credentials at once would otherwise write into each other's
 * state directory. Serializing every mutation through one queue keeps that
 * window exclusive while leaving the rest of each connection's work parallel.
 */
export function withOpenClawEnv<T>(
	overrides: EnvOverrides,
	operation: () => Promise<T>
): Promise<T> {
	const result = tail.then(async () => {
		const previous = new Map<string, string | undefined>(
			Object.keys(overrides).map((name) => [name, process.env[name]])
		);
		try {
			for (const [name, value] of Object.entries(overrides)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			return await operation();
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
	tail = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}
