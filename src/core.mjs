// Sync engine: Plaud's official API → one Markdown note per recording in an Obsidian vault.
//
// Shared by the Obsidian plugin (plugin/main.mjs) and the command line (cli.mjs). It only uses
// Node built-ins plus an injectable `fetch`, so the plugin can route requests through Obsidian.
//
// Authentication reuses the session of Plaud's official CLI (`plaud login`, tokens in
// ~/.plaud/tokens.json) and refreshes it the same way the CLI does.
//
// A note is written once Plaud has finished processing the recording (summary available, or only a
// transcript for more than 24 h). Recordings that are not transcribed yet stay pending and are
// checked again on every sync, so no empty note is ever written. Notes are never rewritten:
// users can edit, move or delete them freely, and a deleted note is not recreated.

import {copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, relative} from 'node:path';

export const DEFAULT_API_BASE = 'https://platform.plaud.ai/developer/api';
const PAGE_SIZE = 100;
const DAY = 24 * 60 * 60 * 1000;
const TRANSCRIPT_ONLY_WAIT_MS = DAY;
const LOCK_STALE_MS = 30 * 60 * 1000;
// Plaud rate-limits the API (HTTP 429): requests are spaced, and we back off when asked to.
const RATE_LIMIT_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

export class PlaudSyncError extends Error {
	// kind: 'auth' (run `plaud login`), 'network', 'config', or 'busy' (another sync is running).
	constructor(kind, message) {
		super(message);
		this.name = 'PlaudSyncError';
		this.kind = kind;
	}
}

export const defaultTokenFile = () => join(homedir(), '.plaud', 'tokens.json');

const pad = (n) => String(n).padStart(2, '0');
const str = (value) => (typeof value === 'string' ? value.trim() : '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The official API prefixes ids with "of_"; the old Plaud Sync plugin did not.
const idKey = (id) => String(id).replace(/^of_/, '');

export const NOTE_LANGUAGES = {
	en: {
		summary: 'Summary',
		transcript: 'Transcript',
		otherNote: 'Plaud note',
		untitled: 'Plaud recording',
		noSummary: '_No summary available._',
		noTranscript: '_No transcript available._',
		titleKey: 'title',
		durationKey: 'duration_min',
		timeSeparator: '.',
		speakerSeparator: ':',
		duration: (h, m) => `${h}h${pad(m)}`,
		callout: (d, time, duration) => `Plaud recording · ${isoDate(d)} ${time}${duration ? ` · ${duration}` : ''}`
	},
	fr: {
		summary: 'Résumé',
		transcript: 'Transcription',
		otherNote: 'Note Plaud',
		untitled: 'Enregistrement Plaud',
		noSummary: '_Pas de résumé disponible._',
		noTranscript: '_Pas de transcription disponible._',
		titleKey: 'titre',
		durationKey: 'duree_min',
		timeSeparator: 'h',
		speakerSeparator: ' :',
		duration: (h, m) => `${h} h ${pad(m)}`,
		callout: (d, time, duration) =>
			`Enregistrement Plaud du ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${time}${duration ? ` · ${duration}` : ''}`
	}
};

// Plaud prefixes generated titles with the date ("10-01 Meeting…"), which the file name already has.
const displayTitle = (name, strings) => str(name).replace(/^\d{2}-\d{2}\s+/, '') || strings.untitled;

async function readJson(path, fallback) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return fallback;
		throw new PlaudSyncError('config', `Cannot read ${path} (${err.message})`);
	}
}

async function writeJsonAtomic(path, value, mode) {
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode});
	await rename(tmp, path);
}

// --- Plaud session (same token file and refresh flow as the official CLI) ---

export async function readPlaudLogin(tokenFile = defaultTokenFile()) {
	const tokens = await readJson(tokenFile, null).catch(() => null);
	return {loggedIn: Boolean(tokens?.access_token), tokenFile};
}

async function getAccessToken(ctx) {
	const tokens = await readJson(ctx.tokenFile, null);
	if (!tokens?.access_token) {
		throw new PlaudSyncError('auth', 'Not logged in to Plaud. Install the official Plaud CLI and run `plaud login`.');
	}
	if (!tokens.expires_at || Date.now() < tokens.expires_at - 60_000) {
		return tokens.access_token;
	}
	if (!tokens.refresh_token) {
		throw new PlaudSyncError('auth', 'Plaud session expired. Run `plaud login` again.');
	}

	let res;
	try {
		res = await ctx.fetch(`${ctx.apiBase}/oauth/third-party/access-token/refresh`, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
			body: new URLSearchParams({refresh_token: tokens.refresh_token}),
			signal: AbortSignal.timeout(30_000)
		});
	} catch (err) {
		throw new PlaudSyncError('network', `Cannot reach Plaud to refresh the session (${err.message}).`);
	}
	if (res.status === 401 || res.status === 403) {
		throw new PlaudSyncError('auth', 'Plaud session expired. Run `plaud login` again.');
	}
	if (!res.ok) {
		throw new PlaudSyncError('network', `Plaud session refresh failed (HTTP ${res.status}).`);
	}

	const data = await res.json();
	const refreshed = {
		access_token: data.access_token,
		refresh_token: data.refresh_token ?? tokens.refresh_token,
		token_type: data.token_type ?? 'Bearer',
		expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
	};
	await writeJsonAtomic(ctx.tokenFile, refreshed, 0o600);
	return refreshed.access_token;
}

// --- Plaud API ---

let lastRequestAt = 0;

function retryAfterMs(res, attempt) {
	const header = res.headers.get('retry-after');
	const seconds = header === null || header === undefined ? NaN : Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 120) * 1000 : RATE_LIMIT_WAITS_MS[attempt - 1];
}

async function api(path, token, ctx) {
	for (let attempt = 1; ; attempt++) {
		const wait = lastRequestAt + ctx.requestSpacingMs - Date.now();
		if (wait > 0) await sleep(wait);
		lastRequestAt = Date.now();

		let res;
		try {
			res = await ctx.fetch(`${ctx.apiBase}${path}`, {
				headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
				signal: AbortSignal.timeout(30_000)
			});
		} catch (err) {
			if (attempt < 3) {
				await sleep(1000 * attempt);
				continue;
			}
			throw new PlaudSyncError('network', `Cannot reach Plaud (${err.message}). Check your connection.`);
		}

		if (res.status === 401) {
			throw new PlaudSyncError('auth', 'Plaud refused the session. Run `plaud login` again.');
		}
		if (res.status === 429 && attempt <= RATE_LIMIT_WAITS_MS.length) {
			await sleep(retryAfterMs(res, attempt));
			continue;
		}
		if (res.status >= 500 && attempt < 3) {
			await sleep(2000 * attempt);
			continue;
		}
		if (!res.ok) {
			throw new Error(`Plaud answered HTTP ${res.status}`);
		}
		return res.json();
	}
}

async function listAllFiles(token, sinceMs, ctx) {
	const files = [];
	for (let page = 1; page <= 1000; page++) {
		const params = new URLSearchParams({page: String(page), page_size: String(PAGE_SIZE)});
		if (sinceMs !== undefined) params.set('start_date', String(sinceMs));
		const result = await api(`/open/third-party/files/?${params}`, token, ctx);
		const data = Array.isArray(result?.data) ? result.data : [];
		files.push(...data);
		if (data.length < PAGE_SIZE) break;
	}
	return files;
}

async function blockText(block, ctx) {
	if (typeof block?.data_content === 'string' && block.data_content) {
		return block.data_content;
	}
	if (typeof block?.data_link === 'string' && block.data_link) {
		const res = await ctx.fetch(block.data_link, {signal: AbortSignal.timeout(30_000)});
		if (!res.ok) throw new Error(`content unavailable (HTTP ${res.status})`);
		return res.text();
	}
	return '';
}

// --- Rendering ---

// Timestamps without a time zone are UTC (same rule as the official CLI).
function parseTimestamp(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const s = str(value);
	if (!s) return null;
	const normalized = /\d{2}:\d{2}/.test(s) && !/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(s) ? `${s}Z` : s;
	const ms = new Date(normalized).getTime();
	return Number.isNaN(ms) ? null : ms;
}

function clock(ms) {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function humanDuration(ms, strings) {
	if (!ms || ms < 0) return '';
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return `${Math.round(ms / 1000)} s`;
	if (minutes < 60) return `${minutes} min`;
	return strings.duration(Math.floor(minutes / 60), minutes % 60);
}

// The summary sits under a level-2 heading: its own headings start at level 3.
function demoteHeadings(markdown) {
	const lines = markdown.split('\n');
	const outsideFences = (fn) => {
		let inFence = false;
		return lines.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			return inFence ? line : fn(line);
		});
	};

	let top = 7;
	outsideFences((line) => {
		const level = /^(#{1,6})\s/.exec(line)?.[1].length;
		if (level) top = Math.min(top, level);
		return line;
	});
	const shift = Math.max(0, 3 - top);
	if (shift === 0) return markdown;

	return outsideFences((line) => line.replace(/^(#{1,6})(?=\s)/, (hashes) => '#'.repeat(Math.min(6, hashes.length + shift)))).join('\n');
}

function cleanNoteText(raw) {
	let text = raw.trim();
	if (text.startsWith('{') || text.startsWith('"')) {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === 'string') {
				text = parsed;
			} else if (parsed && typeof parsed === 'object') {
				text = str(parsed.ai_content) || str(parsed.content) || str(parsed.summary) || text;
			}
		} catch {
			// plain text
		}
	}
	// Summaries start with image links internal to the Plaud app (plaud://…), useless in Obsidian.
	text = text.replace(/!?\[[^\]]*\]\(plaud:\/\/[^)]*\)[ \t]*\n?/g, '');
	// A "---" right under a paragraph would turn it into a heading (Setext syntax): separate them.
	text = text.replace(/([^\n])\n(-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/g, '$1\n\n$2');
	return demoteHeadings(text.trim());
}

function renderTranscript(raw, strings) {
	const text = raw.trim();
	if (!text) return '';

	let segments;
	try {
		segments = JSON.parse(text);
	} catch {
		return text;
	}
	if (!Array.isArray(segments)) return text;

	// Consecutive segments from the same speaker are merged into one paragraph.
	const paragraphs = [];
	for (const segment of segments) {
		const content = str(segment?.content);
		if (!content) continue;
		const speaker = str(segment?.speaker);
		const previous = paragraphs.at(-1);
		if (previous && speaker && previous.speaker === speaker) {
			previous.text += ` ${content}`;
			continue;
		}
		const time = typeof segment?.start_time === 'number' ? clock(segment.start_time) : '';
		paragraphs.push({speaker, time, text: content});
	}

	return paragraphs
		.map((p) => {
			const label = [p.time && `[${p.time}]`, p.speaker].filter(Boolean).join(' ');
			return label ? `**${label}**${strings.speakerSeparator} ${p.text}` : p.text;
		})
		.join('\n\n');
}

async function loadContent(detail, ctx, strings) {
	const sources = Array.isArray(detail.source_list) ? detail.source_list : [];
	const notes = Array.isArray(detail.note_list) ? detail.note_list : [];

	const transcriptBlock = sources.find((s) => s?.data_type === 'transaction');
	const transcript = transcriptBlock ? renderTranscript(await blockText(transcriptBlock, ctx), strings) : '';

	const sections = [];
	let hasMainSummary = false;
	for (const note of notes) {
		const text = cleanNoteText(await blockText(note, ctx));
		if (!text) continue;
		const isMainSummary = note.data_type === 'auto_sum_note' && !hasMainSummary;
		if (isMainSummary) hasMainSummary = true;
		const heading = isMainSummary ? strings.summary : str(note.data_tab_name) || str(note.data_title) || strings.otherNote;
		sections[isMainSummary ? 'unshift' : 'push']({heading, text});
	}

	return {transcript, sections};
}

function noteFileName(date, time, title, strings) {
	const sep = strings.timeSeparator;
	const full = title
		.replace(/(\d{2}):(\d{2})(?::\d{2})?/g, `$1${sep}$2`)
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|[.\s]+$/g, '');
	const clean = full.length <= 100 ? full : full.slice(0, 100).replace(/\s+\S*$/, '').replace(/[\s,;:(–—-]+$/, '');
	if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return `${clean}.md`;
	return `${date} ${time.replace(':', sep)} - ${clean || strings.untitled}.md`;
}

function renderNote(file, content, {includeTranscript, strings}) {
	const title = displayTitle(file.name, strings);
	const startMs = parseTimestamp(file.start_at) ?? parseTimestamp(file.created_at) ?? Date.now();
	const d = new Date(startMs);
	const date = isoDate(d);
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const duration = humanDuration(file.duration, strings);

	const lines = ['---', `plaud_id: ${file.id}`, `${strings.titleKey}: ${JSON.stringify(title)}`, `date: ${date}T${time}`];
	if (file.duration > 0) lines.push(`${strings.durationKey}: ${Math.max(1, Math.round(file.duration / 60000))}`);
	lines.push('source: plaud', 'tags:', '  - plaud', '---', '', `# ${title}`, '', `> [!info] ${strings.callout(d, time, duration)}`, '');

	const sections = content.sections.length > 0 ? content.sections : [{heading: strings.summary, text: strings.noSummary}];
	for (const section of sections) {
		lines.push(`## ${section.heading}`, '', section.text, '');
	}
	// Without a summary the transcript is kept even if not wanted: it is all there is.
	if (includeTranscript || content.sections.length === 0) {
		lines.push(`## ${strings.transcript}`, '', content.transcript || strings.noTranscript, '');
	}

	return {fileName: noteFileName(date, time, title, strings), text: lines.join('\n')};
}

// --- Vault ---

async function listMarkdownFiles(dir) {
	const out = [];
	for (const entry of await readdir(dir, {withFileTypes: true})) {
		if (entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listMarkdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
	}
	return out;
}

// Finds notes already in the folder: ours (plaud_id) and those of the old Plaud Sync plugin
// (file_id), flagging the ones it left empty.
async function indexExistingNotes(folder) {
	const found = new Map();
	if (!existsSync(folder)) return found;

	for (const path of await listMarkdownFiles(folder)) {
		const text = await readFile(path, 'utf8');
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
		if (!frontmatter) continue;

		const id = /^plaud_id:\s*["']?([^"'\s]+)/m.exec(frontmatter)?.[1];
		if (id) {
			found.set(idKey(id), {path, legacy: false});
			continue;
		}

		const legacyId = /^file_id:\s*["']?([^"'\s]+)/m.exec(frontmatter)?.[1];
		if (legacyId && /^source:\s*plaud\s*$/m.test(frontmatter)) {
			const incomplete = text.includes('No summary available.') || text.includes('No transcript available.');
			found.set(idKey(legacyId), {path, legacy: true, incomplete});
		}
	}
	return found;
}

async function writeNewNote(folder, fileName, text) {
	await mkdir(folder, {recursive: true});
	const base = fileName.replace(/\.md$/, '');
	for (let n = 1; ; n++) {
		const path = join(folder, n === 1 ? fileName : `${base} (${n}).md`);
		try {
			await writeFile(path, text, {encoding: 'utf8', flag: 'wx'});
			return path;
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
		}
	}
}

async function moveToBackup(path, backupDir) {
	await mkdir(backupDir, {recursive: true});
	const target = join(backupDir, `${Date.now()}-${basename(path)}`);
	try {
		await rename(path, target);
	} catch (err) {
		if (err.code !== 'EXDEV') throw err;
		await copyFile(path, target);
		await unlink(path);
	}
}

// One sync at a time per vault (plugin and command line may overlap). A lock older than
// 30 minutes is considered abandoned (interrupted sync).
async function acquireLock(lockPath) {
	try {
		await mkdir(lockPath);
		return true;
	} catch (err) {
		if (err.code !== 'EEXIST') throw err;
	}
	const age = Date.now() - (await stat(lockPath)).mtimeMs;
	if (age < LOCK_STALE_MS) return false;
	await rm(lockPath, {recursive: true, force: true});
	await mkdir(lockPath);
	return true;
}

// --- Sync ---

function isReady(content, waitedMs) {
	if (content.sections.length > 0) return true;
	return Boolean(content.transcript) && waitedMs >= TRANSCRIPT_ONLY_WAIT_MS;
}

function localDayStart(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
	if (!match) return null;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

export const stateFileFor = (vaultPath, configDir = '.obsidian') => join(vaultPath, configDir, 'plaud-to-obsidian.json');

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
	const relFolder = str(folder).replace(/^[/\\]+|[/\\]+$/g, '') || 'Plaud';

	const stateFile = stateFileFor(vaultPath, configDir);
	const backupDir = join(vaultPath, configDir, 'plaud-to-obsidian-backups');
	const lockPath = `${stateFile}.lock`;
	const ctx = {fetch: fetchImpl, apiBase, requestSpacingMs, tokenFile};

	if (!dryRun) {
		await mkdir(dirname(stateFile), {recursive: true});
		if (!(await acquireLock(lockPath))) throw new PlaudSyncError('busy', 'A Plaud sync is already running for this vault.');
	}
	try {
		return await runSync({vaultPath, relFolder, includeTranscript, strings, sinceMs, dryRun, limit, stateFile, backupDir, ctx, log});
	} finally {
		if (!dryRun) await rm(lockPath, {recursive: true, force: true});
	}
}

async function runSync({vaultPath, relFolder, includeTranscript, strings, sinceMs, dryRun, limit, stateFile, backupDir, ctx, log}) {
	const folder = join(vaultPath, relFolder);
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
	const existing = await indexExistingNotes(folder);

	const now = Date.now();
	const stats = {listed: files.length, created: 0, replaced: 0, adopted: 0, waiting: 0, errors: 0, createdPaths: []};
	const legacyIds = new Set([...existing].filter(([, note]) => note.legacy).map(([id]) => id));
	const legacyMatched = files.filter((file) => legacyIds.has(idKey(file.id))).length;
	const prefix = dryRun ? '[dry run] ' : '';

	for (const file of files) {
		if (stats.created + stats.replaced >= limit) break;
		if (state.done[file.id]) continue;

		const prior = existing.get(idKey(file.id));
		if (prior && !(prior.legacy && prior.incomplete)) {
			state.done[file.id] = {path: relative(vaultPath, prior.path), at: new Date(now).toISOString()};
			stats.adopted++;
			continue;
		}

		try {
			const detail = await api(`/open/third-party/files/${encodeURIComponent(file.id)}`, token, ctx);
			const merged = {...file, ...detail};
			const content = await loadContent(merged, ctx, strings);

			// The wait counts from the upload to Plaud (created_at), not from the recording itself.
			const firstSeen = state.pending[file.id] ?? now;
			if (!dryRun) state.pending[file.id] = firstSeen;
			const waitedSince = Math.min(firstSeen, parseTimestamp(file.created_at) ?? firstSeen);
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

	if (!dryRun) await writeJsonAtomic(stateFile, state);

	const parts = [
		`${files.length} recording(s) in Plaud`,
		`${stats.created} note(s) ${dryRun ? 'to create' : 'created'}`,
		`${stats.waiting} waiting for Plaud processing`
	];
	if (stats.replaced) parts.push(`${stats.replaced} empty Plaud Sync note(s) ${dryRun ? 'to replace' : 'replaced'}`);
	if (stats.adopted) parts.push(`${stats.adopted} existing note(s) kept`);
	if (stats.errors) parts.push(`${stats.errors} error(s)`);
	log(`${prefix}${parts.join(' · ')}.`);
	if (legacyIds.size > 0) {
		log(`Old Plaud Sync notes in "${relFolder}": ${legacyIds.size}, ${legacyMatched} matched in Plaud.`);
	}
	return stats;
}
