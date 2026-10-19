import {createHash} from 'node:crypto';
import {mkdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import lockfile from 'proper-lockfile';
import {PlaudSyncError} from './errors.mjs';

// The lock is local to this computer, outside the vault: vault sync services (iCloud, Obsidian
// Sync…) would otherwise copy a fresh-looking lock to other devices and block their syncs.
// Locking across devices is impossible anyway; this only coordinates the plugin and the CLI.
export async function lockTargetFor(vaultPath, configDir) {
	const key = createHash('sha256').update(`${await realpath(vaultPath)}\0${configDir}`).digest('hex').slice(0, 16);
	return join(homedir(), '.plaud-to-obsidian-locks', `${key}.json`);
}

// Heartbeats keep long imports alive; crashed processes stop renewing their lease.
export async function acquireLock(target, {stale = 30 * 60 * 1000, update = 10_000} = {}) {
	await mkdir(dirname(target), {recursive: true});
	let compromised;
	let release;
	try {
		release = await lockfile.lock(target, {
			realpath: false, stale, update,
			onCompromised: (err) => { compromised = new PlaudSyncError('busy', `Sync lock lost: ${err.message}`); }
		});
	} catch (err) {
		if (err.code === 'ELOCKED') throw new PlaudSyncError('busy', 'A Plaud sync is already running for this vault.');
		throw err;
	}
	return {
		isOwned: () => !compromised,
		assertOwned() { if (compromised) throw compromised; },
		async release() {
			// A compromised lease must not remove its successor's lock.
			if (!compromised) await release();
		}
	};
}
