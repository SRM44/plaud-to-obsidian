// Public sync entry point, shared by the CLI and the Obsidian plugin.
import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {PlaudSyncError} from './errors.mjs';
import {readJson, writeJsonAtomic} from './json.mjs';
import {DEFAULT_API_BASE, defaultTokenFile, getAccessToken, listAllFiles, api} from './plaud.mjs';
import {NOTE_LANGUAGES, displayTitle, parseTimestamp, renderNote, loadContent} from './render.mjs';
import {indexExistingNotes, writeNewNote, moveToBackup, resolveVaultFolder} from './vault.mjs';
import {acquireLock, lockTargetFor} from './lock.mjs';
import {str, idKey} from './utils.mjs';
export {PlaudSyncError} from './errors.mjs';
export {DEFAULT_API_BASE, defaultTokenFile, readPlaudLogin} from './plaud.mjs';
export {NOTE_LANGUAGES} from './render.mjs';
const TRANSCRIPT_ONLY_WAIT_MS = 24 * 60 * 60 * 1000;

// --- Sync ---

function isReady(content, waitedMs) {
	if (content.sections.length > 0) return true;
	return Boolean(content.transcript) && waitedMs >= TRANSCRIPT_ONLY_WAIT_MS;
}

function localDayStart(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
	if (!match) return null;
	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
}

export const stateFileFor = (vaultPath, configDir = '.obsidian') => join(vaultPath, configDir, 'plaud-to-obsidian.json');
export const lockFileFor = async (vaultPath, configDir = '.obsidian') => `${await lockTargetFor(vaultPath, configDir)}.lock`;

export async function syncVault(options) {
	const {
		vaultPath,
		folder = 'Plaud',
		includeTranscript = true,
		language = 'en',
		since,
		dryRun = false,
		limit = Infinity,
		configDir = '.obsidian',
		tokenFile = defaultTokenFile(),
		apiBase = DEFAULT_API_BASE,
		fetch: fetchImpl = globalThis.fetch,
		log = () => {},
		requestSpacingMs = Number(process.env.PLAUD_SYNC_SPACING_MS ?? 1200)
	} = options;

	const strings = NOTE_LANGUAGES[language];
	if (!strings) throw new PlaudSyncError('config', `Unknown note language "${language}" (use ${Object.keys(NOTE_LANGUAGES).join(' or ')}).`);
	if (!vaultPath || !existsSync(vaultPath)) throw new PlaudSyncError('config', `Vault not found: ${vaultPath}`);
	if (!(limit >= 1)) throw new PlaudSyncError('config', `Limit must be a positive number, not "${limit}".`);
	const sinceMs = since ? localDayStart(since) : undefined;
	if (sinceMs === null) throw new PlaudSyncError('config', `Invalid date "${since}" (expected YYYY-MM-DD).`);
	const relFolder = str(folder) || 'Plaud';
	const folderPath = await resolveVaultFolder(vaultPath, relFolder);
	await resolveVaultFolder(vaultPath, configDir);

	const stateFile = stateFileFor(vaultPath, configDir);
	const backupDir = join(vaultPath, configDir, 'plaud-to-obsidian-backups');
	const ctx = {fetch: fetchImpl, apiBase, requestSpacingMs, tokenFile};

	if (!dryRun) {
		await mkdir(dirname(stateFile), {recursive: true});
	}
	const lease = dryRun
		? {isOwned: () => true, assertOwned() {}, async release() {}}
		: await acquireLock(await lockTargetFor(vaultPath, configDir));
	try {
		return await runSync({vaultPath, relFolder, folder: folderPath, includeTranscript, strings, sinceMs, dryRun, limit, stateFile, backupDir, ctx, log, lease});
	} finally {
		// A failed release must not hide the outcome of the sync itself.
		await lease.release().catch((err) => log(`Could not release the sync lock: ${err.message}`));
	}
}

async function runSync({vaultPath, relFolder, folder, includeTranscript, strings, sinceMs, dryRun, limit, stateFile, backupDir, ctx, log, lease}) {
	const state = await readJson(stateFile, {done: {}, pending: {}});
	state.done ??= {};
	state.pending ??= {};

	const token = await getAccessToken(ctx);
	const files = (await listAllFiles(token, sinceMs, ctx)).filter((file) => {
		if (!file?.id) return false;
		if (sinceMs === undefined) return true;
		const start = parseTimestamp(file.start_at) ?? parseTimestamp(file.created_at);
		return start === null || start >= sinceMs;
	});
	// Existing notes are only read when some recording still needs handling.
	let existing = null;
	const existingNotes = async () => (existing ??= await indexExistingNotes(folder));

	const now = Date.now();
	const stats = {listed: files.length, created: 0, replaced: 0, adopted: 0, waiting: 0, errors: 0, createdPaths: []};
	const prefix = dryRun ? '[dry run] ' : '';
	let folderChecked = false;
	let completed = false;

	// The state is saved even when the run stops early (network, session, lost lock), so that
	// notes written and transcripts seen so far are not forgotten.
	try {
		for (const file of files) {
			if (stats.created + stats.replaced >= limit) break;
			if (state.done[file.id]) continue;

			const prior = (await existingNotes()).get(idKey(file.id));
			if (prior && !(prior.legacy && prior.incomplete)) {
				state.done[file.id] = {path: relative(vaultPath, prior.path), at: new Date(now).toISOString()};
				delete state.pending[file.id];
				stats.adopted++;
				continue;
			}

			try {
				const detail = await api(`/open/third-party/files/${encodeURIComponent(file.id)}`, token, ctx);
				const merged = {...file, ...detail};
				const content = await loadContent(merged, ctx, strings);

				// Legacy numeric pending entries tracked discovery, not transcript availability.
				const previous = state.pending[file.id];
				const transcriptSince = content.transcript
					? (typeof previous === 'object' && Number.isFinite(previous?.transcriptSince) ? previous.transcriptSince : now)
					: null;
				if (!dryRun) state.pending[file.id] = {transcriptSince};
				const waitedSince = transcriptSince ?? now;
				if (!isReady(content, now - waitedSince)) {
					stats.waiting++;
					if (dryRun) {
						const reason = content.transcript ? 'transcript received less than 24 h ago, summary expected' : 'not transcribed yet';
						log(`${prefix}waiting: ${displayTitle(file.name, strings)} (${reason})`);
					}
					continue;
				}

				const note = renderNote(merged, content, {includeTranscript, strings});
				if (dryRun) {
					log(`${prefix}would ${prior ? 'replace the empty Plaud Sync note with' : 'create'} ${join(relFolder, note.fileName)}`);
				} else {
					lease.assertOwned();
					if (!folderChecked) {
						// Checked again right before the first write, in case the folder changed since.
						await resolveVaultFolder(vaultPath, relFolder);
						folderChecked = true;
					}
					if (prior) await moveToBackup(prior.path, backupDir);
					const path = await writeNewNote(folder, note.fileName, note.text);
					const rel = relative(vaultPath, path);
					state.done[file.id] = {path: rel, at: new Date().toISOString()};
					delete state.pending[file.id];
					stats.createdPaths.push(rel);
					log(`${prior ? 'Replaced empty Plaud Sync note' : 'Created'}: ${rel}`);
				}
				stats[prior ? 'replaced' : 'created']++;
			} catch (err) {
				if (err instanceof PlaudSyncError) throw err;
				stats.errors++;
				log(`Error on "${str(file.name) || file.id}": ${err.message} (will retry on next sync)`);
			}
		}

		completed = true;
	} finally {
		if (!dryRun && lease.isOwned()) {
			try {
				await writeJsonAtomic(stateFile, state);
			} catch (err) {
				if (completed) throw err;
				log(`Could not save the sync state: ${err.message}`);
			}
		}
	}
	lease.assertOwned();

	const parts = [
		`${files.length} recording(s) in Plaud`,
		`${stats.created} note(s) ${dryRun ? 'to create' : 'created'}`,
		`${stats.waiting} waiting for Plaud processing`
	];
	if (stats.replaced) parts.push(`${stats.replaced} empty Plaud Sync note(s) ${dryRun ? 'to replace' : 'replaced'}`);
	if (stats.adopted) parts.push(`${stats.adopted} existing note(s) kept`);
	if (stats.errors) parts.push(`${stats.errors} error(s)`);
	log(`${prefix}${parts.join(' · ')}.`);
	const legacyIds = new Set([...(existing ?? [])].filter(([, note]) => note.legacy).map(([id]) => id));
	if (legacyIds.size > 0) {
		const legacyMatched = files.filter((file) => legacyIds.has(idKey(file.id))).length;
		log(`Old Plaud Sync notes in "${relFolder}": ${legacyIds.size}, ${legacyMatched} matched in Plaud.`);
	}
	return stats;
}
