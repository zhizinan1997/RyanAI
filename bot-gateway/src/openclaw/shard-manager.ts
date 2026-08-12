import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger.js';
import type { Channel, ConnectionSnapshot } from '../types.js';

export function shardIdFor(channel: Channel, index: number): string {
	return `${channel}-shard-${String(index).padStart(3, '0')}`;
}

/**
 * Pick the shard for a new account: the lowest-numbered shard of the channel
 * with a free slot, or the next fresh shard id. Counting assigned connections
 * (credentialed or not) keeps a slot reserved through a pending login.
 */
export function assignShard(
	channel: Channel,
	connections: readonly ConnectionSnapshot[],
	capacity: number
): string {
	const counts = new Map<string, number>();
	for (const connection of connections) {
		if (connection.channel !== channel || !connection.shardId) continue;
		counts.set(connection.shardId, (counts.get(connection.shardId) || 0) + 1);
	}
	for (let index = 0; ; index += 1) {
		const shardId = shardIdFor(channel, index);
		if ((counts.get(shardId) || 0) < capacity) return shardId;
	}
}

async function copyMissingFiles(
	sourceDir: string,
	targetDir: string,
	matches: (fileName: string) => boolean
): Promise<number> {
	let entries;
	try {
		entries = await readdir(sourceDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw error;
	}
	let copied = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !matches(entry.name)) continue;
		const targetPath = path.join(targetDir, entry.name);
		await mkdir(targetDir, { recursive: true, mode: 0o700 });
		try {
			await copyFile(path.join(sourceDir, entry.name), targetPath, 1 /* COPYFILE_EXCL */);
			copied += 1;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	return copied;
}

/**
 * Best-effort copy of one WeChat account's per-account files (credentials,
 * getUpdates sync buffer, context tokens, allowFrom) from its old isolated
 * per-connection state tree into the shard's state tree. The vault remains
 * the credential source of truth, so a missing file only costs a re-sync.
 */
export async function migrateIsolatedWeixinState(options: {
	isolatedStateDir: string;
	shardStateDir: string;
	accountIds: readonly string[];
	logger: Logger;
}): Promise<void> {
	const ids = [...new Set(options.accountIds.filter(Boolean))];
	if (ids.length === 0) return;
	const containsAccountId = (fileName: string): boolean =>
		ids.some((id) => fileName.includes(id));
	try {
		const copiedAccounts = await copyMissingFiles(
			path.join(options.isolatedStateDir, 'openclaw-weixin', 'accounts'),
			path.join(options.shardStateDir, 'openclaw-weixin', 'accounts'),
			(fileName) => ids.some((id) => fileName.startsWith(`${id}.`))
		);
		const copiedCredentials = await copyMissingFiles(
			path.join(options.isolatedStateDir, 'credentials'),
			path.join(options.shardStateDir, 'credentials'),
			containsAccountId
		);
		if (copiedAccounts + copiedCredentials > 0) {
			options.logger.info('Migrated isolated WeChat account state into shared shard', {
				copied_account_files: copiedAccounts,
				copied_credential_files: copiedCredentials
			});
		}
	} catch (error) {
		options.logger.warn('Isolated WeChat state migration failed; account will re-sync', {
			error_message: error instanceof Error ? error.message : String(error)
		});
	}
}
