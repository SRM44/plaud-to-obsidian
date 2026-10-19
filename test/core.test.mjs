import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fakeFetch, files, setup} from './helpers.mjs';
import {PlaudSyncError, lockFileFor, stateFileFor, syncVault} from '../src/core.mjs';

const sync = (vault, tokenFile, options = {}) =>
	syncVault({vaultPath: vault, tokenFile, fetch: fakeFetch(), requestSpacingMs: 0, language: 'fr', ...options});
const notes = async (vault, folder = 'Plaud') => (await readdir(join(vault, folder))).sort();
const readState = async (vault) => JSON.parse(await readFile(stateFileFor(vault), 'utf8'));

test('first sync: writes ready notes, waits for the others, replaces notes the old plugin left empty', async () => {
	const {vault, tokenFile} = await setup();
	const stats = await sync(vault, tokenFile);
	assert.equal(stats.created, 1);
	assert.equal(stats.replaced, 1);

	assert.deepEqual(await notes(vault), [
		'2026-10-01 14h00 - Appel client.md',
		'2026-10-18 09h30 - Réunion équipe budget 2027.md',
		'plaud-2026-09-01-vieux.md'
	]);

	const note = await readFile(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md'), 'utf8');
	assert.match(note, /^---\nplaud_id: of_complet\ntitre: "Réunion équipe : budget 2027"\ndate: 2026-10-18T09:30\nduree_min: 23\n/);
	assert.match(note, /> \[!info\] Enregistrement Plaud du 18\/10\/2026 à 09:30 · 23 min/);
	assert.match(note, /## Résumé\n\nIntroduction\.\n\n---\n### Points clés\n\n- Budget validé\n\n```\n# pas un titre\n```/);
	assert.match(note, /\*\*\[00:00\] Alice\*\* : Hello everyone\. Let us start\.\n\n\*\*\[01:05\] Bob\*\* : Sounds good\./);

	const backups = await readdir(join(vault, '.obsidian', 'plaud-to-obsidian-backups'));
	assert.equal(backups.length, 1);
	assert.match(backups[0], /plaud-2026-10-01-appel-client\.md$/);

	const state = await readState(vault);
	assert.deepEqual(Object.keys(state.done).sort(), ['of_ancienComplet', 'of_ancienVide', 'of_complet']);
	assert.deepEqual(Object.keys(state.pending).sort(), ['of_ancienVideJamaisTranscrit', 'of_ancienneTranscription', 'of_transcriptionSeule', 'of_vide']);
});

test('next sync: a transcript-only recording is written after 24 h, nothing is recreated', async () => {
	const {vault, tokenFile} = await setup();
	await sync(vault, tokenFile);

	const state = await readState(vault);
	state.pending.of_transcriptionSeule.transcriptSince -= 25 * 60 * 60 * 1000;
	await writeFile(stateFileFor(vault), JSON.stringify(state));

	const calls = [];
	await sync(vault, tokenFile, {fetch: fakeFetch(calls)});
	assert.ok(existsSync(join(vault, 'Plaud', '2026-10-19 08h12.md')));
	assert.equal(calls.filter((c) => c.includes('/files/of_complet')).length, 0);
	assert.equal((await notes(vault)).length, 4);
	const note = await readFile(join(vault, 'Plaud', '2026-10-19 08h12.md'), 'utf8');
	assert.match(note, /## Résumé\n\n_Pas de résumé disponible\._/);
});

test('a deleted note is not recreated', async () => {
	const {vault, tokenFile} = await setup();
	await sync(vault, tokenFile);
	const {rm} = await import('node:fs/promises');
	await rm(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md'));
	const stats = await sync(vault, tokenFile);
	assert.equal(stats.created, 0);
	assert.ok(!existsSync(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md')));
});

test('dry run writes nothing', async () => {
	const {vault, tokenFile} = await setup();
	const logs = [];
	await sync(vault, tokenFile, {dryRun: true, log: (m) => logs.push(m)});
	assert.deepEqual(await notes(vault), ['plaud-2026-09-01-vieux.md', 'plaud-2026-10-01-appel-client.md']);
	assert.ok(!existsSync(stateFileFor(vault)));
	assert.ok(logs.some((m) => m.includes('[dry run] would create Plaud/2026-10-18 09h30')));
	assert.ok(logs.some((m) => m.includes('[dry run] waiting: Pas encore traité (not transcribed yet)')));
});

test('English notes: English headings, properties and file names', async () => {
	const {vault, tokenFile} = await setup();
	await sync(vault, tokenFile, {language: 'en', folder: 'Meetings/Plaud'});
	const note = await readFile(join(vault, 'Meetings', 'Plaud', '2026-10-18 09.30 - Réunion équipe budget 2027.md'), 'utf8');
	assert.match(note, /^---\nplaud_id: of_complet\ntitle: "Réunion équipe : budget 2027"\ndate: 2026-10-18T09:30\nduration_min: 23\n/);
	assert.match(note, /> \[!info\] Plaud recording · 2026-10-18 09:30 · 23 min/);
	assert.match(note, /## Summary\n\nIntroduction\./);
	assert.match(note, /## Transcript\n\n\*\*\[00:00\] Alice\*\*: Hello everyone\./);
});

test('summary only: no transcript, except as a fallback when there is no summary', async () => {
	const {vault, tokenFile} = await setup();
	await sync(vault, tokenFile, {includeTranscript: false});
	const withSummary = await readFile(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md'), 'utf8');
	assert.match(withSummary, /## Résumé/);
	assert.doesNotMatch(withSummary, /## Transcription/);
	const state = await readState(vault);
	state.pending.of_ancienneTranscription.transcriptSince -= 25 * 60 * 60 * 1000;
	await writeFile(stateFileFor(vault), JSON.stringify(state));
	await sync(vault, tokenFile, {includeTranscript: false});
	const withoutSummary = await readFile(join(vault, 'Plaud', '2026-09-16 14h47 - Nouvel enregistrement 27.md'), 'utf8');
	assert.match(withoutSummary, /## Transcription\n\n\*\*\[00:00\] Alice\*\*/);
});

test('limit: creates at most n notes, the rest comes on the next sync', async () => {
	const {vault, tokenFile} = await setup();
	await sync(vault, tokenFile, {limit: 1});
	assert.deepEqual((await notes(vault)).filter((n) => !n.startsWith('plaud-')), ['2026-10-18 09h30 - Réunion équipe budget 2027.md']);
	await sync(vault, tokenFile);
	assert.equal((await notes(vault)).filter((n) => !n.startsWith('plaud-')).length, 2);
});

test('since: ignores older recordings', async () => {
	const {vault, tokenFile} = await setup();
	const stats = await sync(vault, tokenFile, {since: '2026-10-01'});
	assert.deepEqual((await notes(vault)).filter((n) => !n.startsWith('plaud-')), [
		'2026-10-01 14h00 - Appel client.md',
		'2026-10-18 09h30 - Réunion équipe budget 2027.md'
	]);
	assert.equal(stats.listed, 4);
});

test('expired session: refreshed the way the official CLI does it', async () => {
	const {vault, tokenFile} = await setup({expired: true});
	const calls = [];
	await sync(vault, tokenFile, {fetch: fakeFetch(calls)});
	assert.equal(calls.filter((c) => c.endsWith('/access-token/refresh')).length, 1);
	const tokens = JSON.parse(await readFile(tokenFile, 'utf8'));
	assert.equal(tokens.access_token, 'nouveau');
	assert.equal(tokens.refresh_token, 'refresh2');
});

test('no Plaud login, or refused session: auth error', async () => {
	const {vault} = await setup();
	await assert.rejects(sync(vault, join(vault, 'missing.json')), (err) => err instanceof PlaudSyncError && err.kind === 'auth');
	const {tokenFile} = await setup();
	await assert.rejects(
		sync(vault, tokenFile, {fetch: async () => new Response('{}', {status: 401})}),
		(err) => err instanceof PlaudSyncError && err.kind === 'auth'
	);
});

test('rate limit (HTTP 429): waits and retries instead of failing', async () => {
	const {vault, tokenFile} = await setup();
	const normal = fakeFetch();
	let refused = 0;
	const fetch = async (url, init) => {
		if (String(url).includes('/files/of_complet') && refused < 2) {
			refused++;
			return new Response('{}', {status: 429, headers: {'Retry-After': '0'}});
		}
		return normal(url, init);
	};
	await sync(vault, tokenFile, {fetch});
	assert.equal(refused, 2);
	assert.ok(existsSync(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md')));
});

test('lock: a second simultaneous sync is refused, and the lock is released afterwards', async () => {
	const {vault, tokenFile} = await setup();
	const lock = await lockFileFor(vault);
	assert.ok(!lock.startsWith(vault), 'the lock must not be synced with the vault');
	await mkdir(lock, {recursive: true});
	await assert.rejects(sync(vault, tokenFile), (err) => err instanceof PlaudSyncError && err.kind === 'busy');
	const {rm} = await import('node:fs/promises');
	await rm(lock, {recursive: true});

	await assert.rejects(sync(vault, join(vault, 'missing.json')));
	assert.ok(!existsSync(lock));
});

test('long titles are cut between words', async () => {
	const {vault, tokenFile} = await setup();
	const fetch = fakeFetch();
	const long = 'Réunion Plateforme de marque, calendrier éditorial, catalogue équipements et gouvernance achats (Acme)';
	const wrapped = async (url, init) => {
		const res = await fetch(url, init);
		if (!String(url).endsWith('/files/of_complet')) return res;
		return new Response(JSON.stringify({...(await res.json()), name: long}), {status: 200});
	};
	await sync(vault, tokenFile, {fetch: wrapped});
	assert.ok((await notes(vault)).includes('2026-10-18 09h30 - Réunion Plateforme de marque, calendrier éditorial, catalogue équipements et gouvernance achats.md'));
});

test('destination and config paths cannot escape the vault, including through symlinks', async () => {
	const {vault, root, tokenFile} = await setup();
	const {symlink} = await import('node:fs/promises');
	const outside = join(root, 'outside');
	await mkdir(outside);
	await symlink(outside, join(vault, 'linked'), 'dir');
	for (const folder of ['../outside', '..\\outside', outside, 'C:\\outside', 'linked/new']) {
		await assert.rejects(sync(vault, tokenFile, {folder}), (err) => err.kind === 'config');
	}
	await assert.rejects(sync(vault, tokenFile, {configDir: '../outside'}), (err) => err.kind === 'config');
	assert.deepEqual(await readdir(outside), []);
	assert.ok(!existsSync(stateFileFor(vault)));
});

test('since rejects impossible dates but accepts leap days', async () => {
	const {vault, tokenFile} = await setup();
	for (const since of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-01', '2026-01-00']) {
		await assert.rejects(sync(vault, tokenFile, {since}), (err) => err.kind === 'config');
	}
	await sync(vault, tokenFile, {since: '2024-02-29', dryRun: true});
});

test('old uploads wait from transcript observation; legacy pending timestamps restart safely', async () => {
	const {vault, tokenFile} = await setup();
	await writeFile(stateFileFor(vault), JSON.stringify({done: {}, pending: {of_ancienneTranscription: 1, of_vide: 1}}));
	const before = Date.now();
	await sync(vault, tokenFile);
	const state = await readState(vault);
	assert.ok(!state.done.of_ancienneTranscription);
	assert.ok(state.pending.of_ancienneTranscription.transcriptSince >= before);
	assert.equal(state.pending.of_vide.transcriptSince, null);
	state.pending.of_ancienneTranscription.transcriptSince = Date.now() - 25 * 60 * 60 * 1000;
	await writeFile(stateFileFor(vault), JSON.stringify(state));
	await sync(vault, tokenFile);
	assert.ok((await readState(vault)).done.of_ancienneTranscription);
});

test('saved note paths remain relative when the vault uses a symlink alias', async () => {
	const {vault, root, tokenFile} = await setup();
	const {symlink} = await import('node:fs/promises');
	const alias = join(root, 'alias');
	await symlink(vault, alias, 'dir');
	const stats = await sync(alias, tokenFile);
	assert.ok(stats.createdPaths.every((path) => !path.startsWith('..')));
	assert.ok(Object.values((await readState(vault)).done).every(({path}) => !path.startsWith('..')));
});

test('a sync that stops early still saves the notes written and transcripts seen so far', async () => {
	const {vault, tokenFile} = await setup();
	const normal = fakeFetch();
	const fetch = async (url, init) =>
		String(url).endsWith('/files/of_ancienVideJamaisTranscrit') ? new Response('{}', {status: 401}) : normal(url, init);
	await assert.rejects(sync(vault, tokenFile, {fetch}), (err) => err instanceof PlaudSyncError && err.kind === 'auth');

	const state = await readState(vault);
	assert.ok(state.done.of_complet);
	assert.equal(typeof state.pending.of_transcriptionSeule.transcriptSince, 'number');
	assert.ok(existsSync(join(vault, 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md')));
});

test('a refresh token refused with HTTP 400 is reported as an expired session', async () => {
	const {vault, tokenFile} = await setup({expired: true});
	const fetch = async () => new Response('{"error":"invalid_grant"}', {status: 400});
	await assert.rejects(sync(vault, tokenFile, {fetch}), (err) => err instanceof PlaudSyncError && err.kind === 'auth');
});

test('pagination follows the page size reported by the server', async () => {
	const {vault, tokenFile} = await setup();
	const normal = fakeFetch();
	const all = Object.values(files).map(({id, name, created_at, duration}) => ({id, name, created_at, duration}));
	const fetch = async (url, init) => {
		const u = new URL(url);
		if (u.pathname !== '/developer/api/open/third-party/files/') return normal(url, init);
		const page = Number(u.searchParams.get('page'));
		return new Response(JSON.stringify({data: all.slice((page - 1) * 2, page * 2), page, page_size: 2}), {status: 200});
	};
	const stats = await sync(vault, tokenFile, {fetch, dryRun: true});
	assert.equal(stats.listed, all.length);
});

test('adopting an existing note clears its pending entry', async () => {
	const {vault, tokenFile} = await setup();
	await writeFile(stateFileFor(vault), JSON.stringify({done: {}, pending: {of_ancienComplet: {transcriptSince: null}}}));
	await sync(vault, tokenFile);
	const state = await readState(vault);
	assert.ok(state.done.of_ancienComplet);
	assert.equal(state.pending.of_ancienComplet, undefined);
});
