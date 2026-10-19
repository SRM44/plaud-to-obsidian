// Obsidian plugin: runs the sync engine (src/core.mjs) inside Obsidian, at startup and on a timer,
// plus a "Sync now" command. Bundled into a single main.js by scripts/build-plugin.mjs.

import {FileSystemAdapter, Notice, Platform, Plugin, PluginSettingTab, Setting, requestUrl} from 'obsidian';
import {NOTE_LANGUAGES, PlaudSyncError, readPlaudLogin, syncVault} from '../src/core.mjs';

const STARTUP_DELAY_MS = 15 * 1000;

const UI = {
	en: {
		syncNow: 'Sync now',
		started: 'Plaud sync started…',
		busy: 'A Plaud sync is already running.',
		done: (s) => `Plaud sync done: ${s.created} new note(s), ${s.waiting} recording(s) waiting for Plaud.`,
		newNotes: (n, folder) => `Plaud: ${n} new note(s) in ${folder}.`,
		auth: 'Plaud: not logged in, or the session expired. In a terminal, run: plaud login (Plaud official CLI).',
		failed: (message) => `Plaud sync failed: ${message}`,
		desktopOnly: 'Plaud sync needs a local vault on the desktop app.',
		login: 'Plaud connection',
		loggedIn: (path) => `Logged in (session of Plaud's official CLI, ${path}).`,
		loggedOut:
			'Not logged in. Install Node.js, then in a terminal run: npm install -g @plaud-ai/cli, then: plaud login. Click "Check again" afterwards.',
		checkAgain: 'Check again',
		folder: 'Destination folder',
		folderDesc: 'Folder of the vault where notes are created.',
		transcript: 'Include transcript',
		transcriptDesc: 'Off: the Plaud summary only (the transcript is still used when a recording has no summary).',
		language: 'Note language',
		languageDesc: 'Language of headings and properties in new notes.',
		since: 'Only recordings since',
		sinceDesc: 'YYYY-MM-DD. Leave empty to import everything.',
		interval: 'Automatic sync',
		intervalDesc: 'At Obsidian startup, then at this interval while Obsidian is open.',
		off: 'Off',
		every: (m) => (m < 60 ? `Every ${m} min` : `Every ${m / 60} h`),
		run: 'Sync Plaud recordings now',
		runButton: 'Sync now'
	},
	fr: {
		syncNow: 'Synchroniser maintenant',
		started: 'Synchro Plaud lancée…',
		busy: 'Une synchro Plaud est déjà en cours.',
		done: (s) => `Synchro Plaud terminée : ${s.created} nouvelle(s) note(s), ${s.waiting} enregistrement(s) en attente chez Plaud.`,
		newNotes: (n, folder) => `Plaud : ${n} nouvelle(s) note(s) dans ${folder}.`,
		auth: 'Plaud : pas connecté, ou connexion expirée. Dans un terminal, lance : plaud login (CLI officiel de Plaud).',
		failed: (message) => `Synchro Plaud en échec : ${message}`,
		desktopOnly: 'La synchro Plaud nécessite un coffre local sur l’application de bureau.',
		login: 'Connexion Plaud',
		loggedIn: (path) => `Connecté (session du CLI officiel de Plaud, ${path}).`,
		loggedOut:
			'Pas connecté. Installe Node.js, puis dans un terminal lance : npm install -g @plaud-ai/cli, puis : plaud login. Clique ensuite sur « Vérifier ».',
		checkAgain: 'Vérifier',
		folder: 'Dossier de destination',
		folderDesc: 'Dossier du coffre où les notes sont créées.',
		transcript: 'Inclure la transcription',
		transcriptDesc: 'Désactivé : seulement la synthèse Plaud (la transcription sert quand même si un enregistrement n’a pas de synthèse).',
		language: 'Langue des notes',
		languageDesc: 'Langue des titres et propriétés des nouvelles notes.',
		since: 'Seulement depuis',
		sinceDesc: 'AAAA-MM-JJ. Laisser vide pour tout importer.',
		interval: 'Synchro automatique',
		intervalDesc: 'À l’ouverture d’Obsidian, puis à cet intervalle tant qu’Obsidian est ouvert.',
		off: 'Désactivée',
		every: (m) => (m < 60 ? `Toutes les ${m} min` : `Toutes les ${m / 60} h`),
		run: 'Synchroniser les enregistrements Plaud maintenant',
		runButton: 'Synchroniser'
	}
};

const uiLanguage = () => ((window.localStorage.getItem('language') ?? 'en').startsWith('fr') ? 'fr' : 'en');

const DEFAULT_SETTINGS = {
	folder: 'Plaud',
	includeTranscript: true,
	language: uiLanguage(),
	since: '',
	intervalMinutes: 30
};

// Plaud's API does not allow browser (CORS) requests: go through Obsidian's requestUrl.
async function obsidianFetch(url, init = {}) {
	const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
	const res = await requestUrl({url, method: init.method ?? 'GET', headers: init.headers, body, throw: false});
	const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
	return {
		ok: res.status >= 200 && res.status < 300,
		status: res.status,
		headers: {get: (name) => headers[name.toLowerCase()] ?? null},
		json: async () => res.json,
		text: async () => res.text
	};
}

export default class PlaudRecordingsSyncPlugin extends Plugin {
	running = false;
	timer = null;

	get ui() {
		return UI[uiLanguage()];
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PlaudSettingTab(this.app, this));
		if (!Platform.isDesktopApp) return;

		this.addCommand({id: 'sync-now', name: this.ui.syncNow, callback: () => this.sync(true)});
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.intervalMinutes > 0) {
				const startup = window.setTimeout(() => this.sync(false), STARTUP_DELAY_MS);
				this.register(() => window.clearTimeout(startup));
			}
			this.schedule();
		});
	}

	onunload() {
		if (this.timer !== null) window.clearInterval(this.timer);
	}

	schedule() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		if (this.settings.intervalMinutes > 0) {
			this.timer = window.setInterval(() => this.sync(false), this.settings.intervalMinutes * 60 * 1000);
		}
	}

	async loadSettings() {
		this.settings = {...DEFAULT_SETTINGS, ...(await this.loadData())};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async sync(manual) {
		if (this.running) {
			if (manual) new Notice(this.ui.busy);
			return;
		}
		const adapter = this.app.vault.adapter;
		if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
			if (manual) new Notice(this.ui.desktopOnly);
			return;
		}

		this.running = true;
		if (manual) new Notice(this.ui.started);
		try {
			const stats = await syncVault({
				vaultPath: adapter.getBasePath(),
				configDir: this.app.vault.configDir,
				folder: this.settings.folder,
				includeTranscript: this.settings.includeTranscript,
				language: this.settings.language,
				since: this.settings.since || undefined,
				fetch: obsidianFetch,
				log: (message) => console.log(`[plaud-recordings-sync] ${message}`)
			});
			if (manual) new Notice(this.ui.done(stats), 10000);
			else if (stats.created + stats.replaced > 0) new Notice(this.ui.newNotes(stats.created + stats.replaced, this.settings.folder), 8000);
		} catch (err) {
			if (err instanceof PlaudSyncError && err.kind === 'busy') {
				if (manual) new Notice(this.ui.busy);
			} else if (err instanceof PlaudSyncError && err.kind === 'auth') {
				new Notice(this.ui.auth, manual ? 15000 : 0);
			} else {
				console.error('[plaud-recordings-sync]', err);
				if (manual || !(err instanceof PlaudSyncError && err.kind === 'network')) {
					new Notice(this.ui.failed(err.message), 15000);
				}
			}
		} finally {
			this.running = false;
		}
	}
}

class PlaudSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const {containerEl} = this;
		const ui = this.plugin.ui;
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		const login = new Setting(containerEl).setName(ui.login).setDesc('…');
		const checkLogin = async () => {
			login.setDesc('…');
			try {
				const {loggedIn, tokenFile} = await readPlaudLogin();
				login.setDesc(loggedIn ? ui.loggedIn(tokenFile) : ui.loggedOut);
			} catch (err) {
				console.error('[plaud-recordings-sync]', err);
				login.setDesc(ui.failed(err?.message ?? String(err)));
			}
		};
		login.addButton((button) => button.setButtonText(ui.checkAgain).onClick(checkLogin));
		checkLogin();

		new Setting(containerEl)
			.setName(ui.folder)
			.setDesc(ui.folderDesc)
			.addText((text) =>
				text
					.setPlaceholder('Plaud')
					.setValue(settings.folder)
					.onChange(async (value) => {
						settings.folder = value.trim() || 'Plaud';
						await save();
					})
			);

		new Setting(containerEl)
			.setName(ui.transcript)
			.setDesc(ui.transcriptDesc)
			.addToggle((toggle) =>
				toggle.setValue(settings.includeTranscript).onChange(async (value) => {
					settings.includeTranscript = value;
					await save();
				})
			);

		new Setting(containerEl)
			.setName(ui.language)
			.setDesc(ui.languageDesc)
			.addDropdown((dropdown) => {
				for (const code of Object.keys(NOTE_LANGUAGES)) dropdown.addOption(code, code === 'fr' ? 'Français' : 'English');
				dropdown.setValue(settings.language).onChange(async (value) => {
					settings.language = value;
					await save();
				});
			});

		new Setting(containerEl)
			.setName(ui.since)
			.setDesc(ui.sinceDesc)
			.addText((text) =>
				text
					.setPlaceholder('2026-01-01')
					.setValue(settings.since)
					.onChange(async (value) => {
						settings.since = value.trim();
						await save();
					})
			);

		new Setting(containerEl)
			.setName(ui.interval)
			.setDesc(ui.intervalDesc)
			.addDropdown((dropdown) => {
				for (const minutes of [0, 15, 30, 60, 120]) dropdown.addOption(String(minutes), minutes ? ui.every(minutes) : ui.off);
				dropdown.setValue(String(settings.intervalMinutes)).onChange(async (value) => {
					settings.intervalMinutes = Number(value);
					await save();
					this.plugin.schedule();
				});
			});

		new Setting(containerEl)
			.setName(ui.run)
			.addButton((button) => button.setButtonText(ui.runButton).setCta().onClick(() => this.plugin.sync(true)));
	}
}
