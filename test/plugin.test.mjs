// Builds dist/main.js and loads it the way Obsidian does (CommonJS, with an `obsidian` module),
// against a fake Obsidian API and the fake Plaud API.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vm from 'node:vm';
import {fakeFetch, setup} from './helpers.mjs';
import {buildPlugin} from '../scripts/build-plugin.mjs';

process.env.PLAUD_SYNC_SPACING_MS = '0';

function fakeObsidian(notices) {
	class FileSystemAdapter {
		constructor(base) {
			this.base = base;
		}
		getBasePath() {
			return this.base;
		}
	}
	class Plugin {
		constructor(app, manifest) {
			this.app = app;
			this.manifest = manifest;
			this.commands = [];
			this.data = null;
		}
		async loadData() {
			return this.data;
		}
		async saveData(data) {
			this.data = data;
		}
		addCommand(command) {
			this.commands.push(command);
		}
		addSettingTab(tab) {
			this.settingTab = tab;
		}
		register() {}
	}
	class PluginSettingTab {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = {empty() {}};
		}
	}
	const chain = new Proxy({}, {get: (_, prop) => (prop === 'then' ? undefined : () => chain)});
	class Setting {
		constructor() {
			return chain;
		}
	}
	const fetch = fakeFetch();
	async function requestUrl({url, method, headers, body}) {
		const res = await fetch(url, {method, headers, body: body === undefined ? undefined : new URLSearchParams(body)});
		const text = await res.text();
		return {status: res.status, headers: Object.fromEntries(res.headers), text, get json() { return JSON.parse(text); }};
	}
	return {FileSystemAdapter, Notice: class { constructor(message) { notices.push(message); } }, Platform: {isDesktopApp: true}, Plugin, PluginSettingTab, Setting, requestUrl};
}

async function loadPlugin(outDir, notices, language = 'en', overrides = {}) {
	const source = await readFile(await buildPlugin(outDir), 'utf8');
	const obsidian = {...fakeObsidian(notices), ...overrides.obsidian};
	const nodeRequire = createRequire(import.meta.url);
	const module = {exports: {}};
	const window = {
		localStorage: {getItem: (key) => (key === 'language' ? language : null)},
		setTimeout: () => 0,
		clearTimeout() {},
		setInterval: () => 1,
		clearInterval() {}
	};
	const context = vm.createContext({module, exports: module.exports, require: (name) => (name === 'obsidian' ? obsidian : nodeRequire(name)), window, console, process, URLSearchParams, AbortSignal: overrides.AbortSignal ?? AbortSignal, setTimeout, clearTimeout, Buffer});
	context.global = context;
	vm.runInContext(source, context, {filename: 'main.js'});
	return {PluginClass: module.exports, obsidian};
}

test('the bundled plugin syncs from inside Obsidian, through requestUrl', async () => {
	const {vault, root} = await setup({expired: true});
	const notices = [];
	const {PluginClass, obsidian} = await loadPlugin(join(root, 'dist'), notices, 'fr');
	const app = {vault: {adapter: new obsidian.FileSystemAdapter(vault), configDir: '.obsidian'}, workspace: {onLayoutReady: (cb) => cb()}};
	const plugin = new PluginClass(app, {id: 'plaud-recordings-sync'});
	await plugin.onload();

	assert.equal(plugin.settings.language, 'fr');
	assert.deepEqual(plugin.commands.map((c) => c.name), ['Synchroniser maintenant']);

	plugin.settings = {...plugin.settings, folder: 'Meetings/Plaud', includeTranscript: false};
	await plugin.sync(true);

	assert.deepEqual(notices, ['Synchro Plaud lancée…', 'Synchro Plaud terminée : 2 nouvelle(s) note(s), 5 enregistrement(s) en attente chez Plaud.']);
	const created = (await readdir(join(vault, 'Meetings', 'Plaud'))).sort();
	assert.deepEqual(created, ['2026-10-01 14h00 - Appel client.md', '2026-10-18 09h30 - Réunion équipe budget 2027.md']);
	const note = await readFile(join(vault, 'Meetings', 'Plaud', created[1]), 'utf8');
	assert.match(note, /## Résumé/);
	assert.doesNotMatch(note, /## Transcription/);
});

test('the bundled plugin explains how to log in when there is no Plaud session', async () => {
	const {vault, root, tokenFile} = await setup();
	const {rm} = await import('node:fs/promises');
	await rm(tokenFile);
	const notices = [];
	const {PluginClass, obsidian} = await loadPlugin(join(root, 'dist'), notices, 'en');
	const plugin = new PluginClass({vault: {adapter: new obsidian.FileSystemAdapter(vault), configDir: '.obsidian'}, workspace: {onLayoutReady() {}}}, {});
	await plugin.onload();
	await plugin.sync(false);
	assert.deepEqual(notices, ['Plaud: not logged in, or the session expired. In a terminal, run: plaud login (Plaud official CLI).']);
});

test('a stalled Obsidian request times out and releases both the running flag and vault lock', async () => {
	const {vault, root} = await setup();
	const notices = [];
	const {PluginClass, obsidian} = await loadPlugin(join(root, 'dist'), notices, 'en', {
		obsidian: {requestUrl: () => new Promise(() => {})},
		AbortSignal: {timeout: () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new Error('request timed out')), 5);
			return controller.signal;
		}}
	});
	const plugin = new PluginClass({vault: {adapter: new obsidian.FileSystemAdapter(vault), configDir: '.obsidian'}, workspace: {onLayoutReady() {}}}, {});
	await plugin.onload();
	await plugin.sync(true);
	assert.equal(plugin.running, false);
	assert.ok(notices.some((message) => message.includes('sync failed')));
	const {access} = await import('node:fs/promises');
	const {lockFileFor} = await import('../src/core.mjs');
	await assert.rejects(access(await lockFileFor(vault)), {code: 'ENOENT'});
});

test('automatic syncs show the login notice once, not on every interval', async () => {
	const {vault, root, tokenFile} = await setup();
	const {rm} = await import('node:fs/promises');
	await rm(tokenFile);
	const notices = [];
	const {PluginClass, obsidian} = await loadPlugin(join(root, 'dist'), notices, 'en');
	const plugin = new PluginClass({vault: {adapter: new obsidian.FileSystemAdapter(vault), configDir: '.obsidian'}, workspace: {onLayoutReady() {}}}, {});
	await plugin.onload();
	await plugin.sync(false);
	await plugin.sync(false);
	await plugin.sync(false);
	assert.equal(notices.length, 1);
});
