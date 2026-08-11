import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface VaultEnvelope {
	version: 1;
	iv: string;
	tag: string;
	ciphertext: string;
}

function assertCredentialObject(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Credentials must be a JSON object');
	}
}

function base64(value: unknown): boolean {
	return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parseEnvelope(raw: string): VaultEnvelope | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
	const envelope = parsed as Partial<VaultEnvelope>;
	if (envelope.version !== 1) return undefined;
	if (!base64(envelope.iv) || !base64(envelope.tag) || !base64(envelope.ciphertext)) {
		return undefined;
	}
	return envelope as VaultEnvelope;
}

export class CredentialVault {
	private readonly secretsDir: string;
	private readonly operations = new Map<string, Promise<void>>();

	constructor(
		dataDir: string,
		private readonly key: Buffer
	) {
		this.secretsDir = path.join(dataDir, 'credentials');
	}

	async initialize(): Promise<void> {
		await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
	}

	async put(connectionId: string, credentials: Record<string, unknown>): Promise<void> {
		return this.serialize(connectionId, async () => {
			assertCredentialObject(credentials);
			const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', this.key, iv);
			cipher.setAAD(Buffer.from(connectionId, 'utf8'));
			const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			const envelope: VaultEnvelope = {
				version: 1,
				iv: iv.toString('base64'),
				tag: cipher.getAuthTag().toString('base64'),
				ciphertext: ciphertext.toString('base64')
			};
			plaintext.fill(0);
			const filePath = this.filePath(connectionId);
			const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
			try {
				await writeFile(tempPath, JSON.stringify(envelope), {
					encoding: 'utf8',
					mode: 0o600
				});
				await rename(tempPath, filePath);
			} finally {
				await rm(tempPath, { force: true });
			}
		});
	}

	async get(connectionId: string): Promise<Record<string, unknown> | undefined> {
		return this.serialize(connectionId, async () => {
			const filePath = this.filePath(connectionId);
			let raw: string;
			try {
				raw = await readFile(filePath, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
				throw error;
			}
			const envelope = parseEnvelope(raw);
			if (!envelope) {
				// A truncated or malformed envelope is unrecoverable but harmless: move it
				// aside and report "no credentials" so the connection asks for a fresh QR
				// login instead of wedging every read behind a parse error.
				await rename(filePath, `${filePath}.corrupt`).catch(() => rm(filePath, { force: true }));
				return undefined;
			}
			// Past this point a failure means the ciphertext did not authenticate under
			// the configured master key. That is a wrong key or tampering, never a
			// missing credential, so it must surface instead of silently logging users out.
			const decipher = createDecipheriv(
				'aes-256-gcm',
				this.key,
				Buffer.from(envelope.iv, 'base64')
			);
			decipher.setAAD(Buffer.from(connectionId, 'utf8'));
			decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
				decipher.final()
			]);
			try {
				const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
				assertCredentialObject(parsed);
				return parsed;
			} finally {
				plaintext.fill(0);
			}
		});
	}

	async delete(connectionId: string): Promise<void> {
		return this.serialize(connectionId, () => rm(this.filePath(connectionId), { force: true }));
	}

	private filePath(connectionId: string): string {
		const digest = createHash('sha256').update(connectionId).digest('hex');
		return path.join(this.secretsDir, `${digest}.json`);
	}

	private async serialize<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.operations.get(connectionId) || Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const tail = result.then(() => undefined, () => undefined);
		this.operations.set(connectionId, tail);
		try {
			return await result;
		} finally {
			if (this.operations.get(connectionId) === tail) this.operations.delete(connectionId);
		}
	}
}
