import lockfile from 'proper-lockfile';
import {PlaudSyncError} from './errors.mjs';

// Heartbeats keep long imports alive; crashed processes stop renewing their lease.
export async function acquireLock(stateFile, {stale = 30 * 60 * 1000, update = 10_000} = {}) {
	let compromised;
	let release;
	try {
		release = await lockfile.lock(stateFile, {
			realpath: false, stale, update,
			onCompromised: (err) => { compromised = new PlaudSyncError('busy', `Sync lock lost: ${err.message}`); }
		});
	} catch (err) {
		if (err.code === 'ELOCKED') throw new PlaudSyncError('busy', 'A Plaud sync is already running for this vault.');
		throw err;
	}
	return {
		assertOwned() { if (compromised) throw compromised; },
		async release() {
			// A compromised lease must not remove its successor's lock.
			if (!compromised) await release();
		}
	};
}
