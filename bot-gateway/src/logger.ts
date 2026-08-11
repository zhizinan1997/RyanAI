const SENSITIVE_KEY =
	/(?:authorization|cookie|secret|token|password|credential|encryption|signature|qrcode|qr_code|session(?:_?state)?|app_?secret|api_?key)/i;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === 'bigint') return value.toString();
	if (typeof value !== 'object') return value;
	if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
	if (seen.has(value)) return '[circular]';
	seen.add(value);

	if (Array.isArray(value)) return value.map((item) => redact(item, seen));

	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, seen);
	}
	return output;
}

export interface LogSink {
	write(line: string): void;
}

const defaultSink: LogSink = {
	write(line) {
		process.stdout.write(`${line}\n`);
	}
};

export class Logger {
	constructor(
		private readonly component: string,
		private readonly sink: LogSink = defaultSink
	) {}

	child(component: string): Logger {
		return new Logger(`${this.component}:${component}`, this.sink);
	}

	debug(message: string, fields: Record<string, unknown> = {}): void {
		if (process.env.LOG_LEVEL === 'debug') this.emit('debug', message, fields);
	}

	info(message: string, fields: Record<string, unknown> = {}): void {
		this.emit('info', message, fields);
	}

	warn(message: string, fields: Record<string, unknown> = {}): void {
		this.emit('warn', message, fields);
	}

	error(message: string, fields: Record<string, unknown> = {}): void {
		this.emit('error', message, fields);
	}

	private emit(level: string, message: string, fields: Record<string, unknown>): void {
		this.sink.write(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				component: this.component,
				message,
				...(redact(fields) as Record<string, unknown>)
			})
		);
	}
}

export function safeErrorFields(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const rawCode = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
		const errorCode = rawCode && /^[a-z][a-z0-9_.-]{0,127}$/.test(rawCode) ? rawCode : undefined;
		const describeCause = (value: unknown, depth = 0): Record<string, unknown> | undefined => {
			if (!(value instanceof Error) || depth > 2) return undefined;
			const causeCode = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
			const nested = describeCause(value.cause, depth + 1);
			return {
				name: value.name,
				...(causeCode ? { code: causeCode.slice(0, 128) } : {}),
				...(value.message.trim() ? { message: value.message.trim().slice(0, 240) } : {}),
				...(nested ? { cause: nested } : {})
			};
		};
		const cause = describeCause(error.cause);
		const message = error.name === 'RyanAiTransportError' ? error.message.trim().slice(0, 240) : '';
		return {
			error_name: error.name,
			...(errorCode ? { error_code: errorCode } : {}),
			...(message ? { error_message: message } : {}),
			...(cause
				? {
						error_cause: cause
					}
				: {})
		};
	}
	return { error_name: 'UnknownError' };
}
