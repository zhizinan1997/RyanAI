import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

export class CredentialVault {
	private readonly secretsDir: string;

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
		await writeFile(this.filePath(connectionId), JSON.stringify(envelope), {
			encoding: 'utf8',
			mode: 0o600
		});
	}

	async get(connectionId: string): Promise<Record<string, unknown> | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.filePath(connectionId), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
		const envelope = JSON.parse(raw) as VaultEnvelope;
		if (envelope.version !== 1) throw new Error('Unsupported credential envelope version');
		const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
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
	}

	async delete(connectionId: string): Promise<void> {
		await rm(this.filePath(connectionId), { force: true });
	}

	private filePath(connectionId: string): string {
		const digest = createHash('sha256').update(connectionId).digest('hex');
		return path.join(this.secretsDir, `${digest}.json`);
	}
}
