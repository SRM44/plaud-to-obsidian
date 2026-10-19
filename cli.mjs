#!/usr/bin/env node
// Command line for plaud-to-obsidian: runs a sync without Obsidian (the plugin does the same thing
// from inside Obsidian). Options given once are remembered in ~/.plaud-to-obsidian.json.

import {existsSync, realpathSync} from 'node:fs';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DEFAULT_API_BASE, PlaudSyncError, syncVault} from './src/core.mjs';

const HELP = `Usage: plaud-to-obsidian [options]

Syncs your Plaud recordings into an Obsidian vault (one note per recording).
Requires Plaud's official CLI to be logged in once: npm install -g @plaud-ai/cli && plaud login

Options (remembered for next runs):
  --vault <path>        Obsidian vault (default: the only vault Obsidian knows)
  --folder <path>       Folder for the notes, inside the vault (default: Plaud)
  --language en|fr      Language of the note template (default: en)
  --transcript          Include the transcript in notes (default)
  --no-transcript       Summary only (the transcript is still used when there is no summary)
  --since YYYY-MM-DD    Ignore recordings made before this date

One-off options:
  --dry-run             Show what would be done, write nothing
  --limit <n>           Create at most n notes
  --help                Show this help`;

const configFile = () => join(homedir(), '.plaud-to-obsidian.json');

function log(message) {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	console.log(`[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}] ${message}`);
}

export function obsidianRegistryPath(platform = process.platform, env = process.env, home = homedir()) {
	if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
	if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
	return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'obsidian', 'obsidian.json');
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return {};
		throw new PlaudSyncError('config', `Cannot read ${path} (${err.message})`);
	}
}

// Without --vault, use the vault Obsidian knows, if there is only one.
async function detectVault() {
	const registry = await readJson(obsidianRegistryPath());
	const vaults = Object.values(registry.vaults ?? {})
		.map((vault) => vault?.path)
		.filter((path) => typeof path === 'string' && existsSync(path));
	if (vaults.length === 1) return vaults[0];
	if (vaults.length === 0) {
		throw new PlaudSyncError('config', 'No Obsidian vault found. Pass it with --vault "/path/to/vault".');
	}
	throw new PlaudSyncError('config', `Several Obsidian vaults found. Pick one with --vault:\n${vaults.map((path) => `  --vault "${path}"`).join('\n')}`);
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new PlaudSyncError('config', `Missing value after ${arg}`);
			return argv[++i];
		};
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--vault') options.vault = next();
		else if (arg === '--folder') options.folder = next();
		else if (arg === '--language') options.language = next();
		else if (arg === '--transcript') options.includeTranscript = true;
		else if (arg === '--no-transcript') options.includeTranscript = false;
		else if (arg === '--since') options.since = next();
		else if (arg === '--limit') options.limit = Number(next());
		else if (arg === '--help' || arg === '-h') options.help = true;
		else throw new PlaudSyncError('config', `Unknown option: ${arg} (see --help)`);
	}
	return options;
}

const EXIT_CODES = {auth: 2, network: 3, config: 1};

export async function run(argv) {
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 18) {
		console.error(`Node ${process.versions.node} is too old: Node 18 or later is required.`);
		return 1;
	}

	try {
		const args = parseArgs(argv);
		if (args.help) {
			console.log(HELP);
			return 0;
		}

		const saved = await readJson(configFile());
		const config = {
			vault: args.vault ?? saved.vault,
			folder: args.folder ?? saved.folder ?? 'Plaud',
			language: args.language ?? saved.language ?? 'en',
			includeTranscript: args.includeTranscript ?? saved.includeTranscript ?? true,
			since: args.since ?? saved.since
		};
		const detected = !config.vault;
		if (detected) {
			config.vault = await detectVault();
			log(`Obsidian vault found: ${config.vault}`);
		}

		const stats = await syncVault({
			vaultPath: config.vault,
			folder: config.folder,
			language: config.language,
			includeTranscript: config.includeTranscript,
			since: config.since,
			dryRun: args.dryRun,
			limit: args.limit ?? Infinity,
			apiBase: process.env.PLAUD_API_BASE ?? DEFAULT_API_BASE,
			log
		});

		const changed = ['vault', 'folder', 'language', 'includeTranscript', 'since'].some((key) => args[key] !== undefined);
		if (changed || (detected && !args.dryRun)) {
			const tmp = `${configFile()}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
			await rename(tmp, configFile());
		}
		return stats.errors ? 1 : 0;
	} catch (err) {
		if (err instanceof PlaudSyncError && err.kind === 'busy') {
			log(`${err.message} Nothing to do.`);
			return 0;
		}
		console.error(err instanceof PlaudSyncError ? err.message : `Unexpected error: ${err.stack ?? err}`);
		return err instanceof PlaudSyncError ? EXIT_CODES[err.kind] ?? 1 : 1;
	}
}

// npm installs the command as a symlink: compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = await run(process.argv.slice(2));
}
