import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fakeFetch, setup} from './helpers.mjs';
import {stateFileFor} from '../src/core.mjs';
import {obsidianRegistryPath, run} from '../cli.mjs';

process.env.PLAUD_SYNC_SPACING_MS = '0';

async function registerVaults(home, paths) {
	const registry = obsidianRegistryPath(process.platform, process.env, home);
	await mkdir(join(registry, '..'), {recursive: true});
	await writeFile(registry, JSON.stringify({vaults: Object.fromEntries(paths.map((path, i) => [`v${i}`, {path, ts: 1}]))}));
}

test('Obsidian registry location on macOS, Windows and Linux', () => {
	assert.equal(obsidianRegistryPath('darwin', {}, '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'obsidian', 'obsidian.json'));
	assert.equal(obsidianRegistryPath('win32', {APPDATA: 'C:\\Users\\a\\AppData\\Roaming'}, 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'obsidian', 'obsidian.json'));
	assert.equal(obsidianRegistryPath('linux', {}, '/home/a'), join('/home/a', '.config', 'obsidian', 'obsidian.json'));
	assert.equal(obsidianRegistryPath('linux', {XDG_CONFIG_HOME: '/cfg'}, '/home/a'), join('/cfg', 'obsidian', 'obsidian.json'));
});

test('without --vault: uses the only vault Obsidian knows, and remembers the options', async () => {
	const {vault, home} = await setup();
	await registerVaults(home, [vault, join(home, 'deleted-vault')]);
	globalThis.fetch = fakeFetch();

	assert.equal(await run(['--dry-run']), 0);
	assert.ok(!existsSync(join(home, '.plaud-to-obsidian.json')));

	assert.equal(await run(['--language', 'fr', '--no-transcript', '--folder', 'Meetings/Plaud']), 0);
	const config = JSON.parse(await readFile(join(home, '.plaud-to-obsidian.json'), 'utf8'));
	assert.deepEqual(config, {vault, folder: 'Meetings/Plaud', language: 'fr', includeTranscript: false});
	const note = await readFile(join(vault, 'Meetings', 'Plaud', '2026-10-18 09h30 - Réunion équipe budget 2027.md'), 'utf8');
	assert.doesNotMatch(note, /## Transcription/);
	assert.ok(existsSync(stateFileFor(vault)));
});

test('several vaults: asks to pick one', async () => {
	const {vault, root, home} = await setup();
	const other = join(root, 'other');
	await mkdir(other);
	await registerVaults(home, [vault, other]);
	globalThis.fetch = fakeFetch();
	assert.equal(await run(['--dry-run']), 1);
});

test('exit codes: 2 when not logged in, 0 when another sync is running, 1 on bad options', async () => {
	const {vault, tokenFile} = await setup();
	const {rm} = await import('node:fs/promises');
	await rm(tokenFile);
	assert.equal(await run(['--vault', vault]), 2);

	await setup();
	await mkdir(`${stateFileFor(vault)}.lock`);
	assert.equal(await run(['--vault', vault]), 0);
	assert.equal(await run(['--vault', vault, '--bogus']), 1);
	assert.equal(await run(['--help']), 0);
	assert.deepEqual(await readdir(join(vault, 'Plaud')), ['plaud-2026-09-01-vieux.md', 'plaud-2026-10-01-appel-client.md']);
});
