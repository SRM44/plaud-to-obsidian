// Shared fixtures: a fake Plaud API and temporary vaults.

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Expected dates and times below are Paris time.
process.env.TZ = 'Europe/Paris';

export const transcript = JSON.stringify([
	{start_time: 0, end_time: 4000, speaker: 'Alice', content: 'Hello everyone.'},
	{start_time: 4000, end_time: 8000, speaker: 'Alice', content: 'Let us start.'},
	{start_time: 65000, end_time: 70000, speaker: 'Bob', content: 'Sounds good.'}
]);

// Upload date one hour ago, in the API format (UTC, no time zone).
const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19);

export const files = {
	of_complet: {
		id: 'of_complet', name: '10-18 Réunion équipe : budget 2027', created_at: '2026-10-18T07:30:00', duration: 1380000,
		source_list: [{data_type: 'transaction', data_link: 'https://s3.example/complet.json'}],
		note_list: [{data_type: 'auto_sum_note', data_content: '[](plaud://image?type=summaryCard&id=x)\nIntroduction.\n---\n# Points clés\n\n- Budget validé\n\n```\n# pas un titre\n```'}]
	},
	of_transcriptionSeule: {
		id: 'of_transcriptionSeule', name: '2026-10-19 08:12:33', created_at: recent, duration: 60000,
		source_list: [{data_type: 'transaction', data_content: transcript}], note_list: []
	},
	of_vide: {id: 'of_vide', name: 'Pas encore traité', created_at: recent, duration: 30000, source_list: [], note_list: []},
	of_ancienneTranscription: {
		id: 'of_ancienneTranscription', name: 'Nouvel enregistrement 27', created_at: '2026-09-25T10:00:00', start_at: '2026-09-16T12:47:26',
		duration: 60000, source_list: [{data_type: 'transaction', data_content: transcript}], note_list: []
	},
	of_ancienVideJamaisTranscrit: {id: 'of_ancienVideJamaisTranscrit', name: 'Nouvel enregistrement 28', created_at: '2026-09-01T10:00:00', duration: 1000, source_list: [], note_list: []},
	of_ancienVide: {
		id: 'of_ancienVide', name: 'Appel client', created_at: '2026-10-01T12:00:00', duration: 600000,
		source_list: [{data_type: 'transaction', data_content: transcript}],
		note_list: [{data_type: 'auto_sum_note', data_content: 'Résumé de l’appel.'}]
	},
	of_ancienComplet: {id: 'of_ancienComplet', name: 'Vieux', created_at: '2026-09-01T12:00:00', duration: 1000, source_list: [], note_list: []}
};

// A fetch() answering like Plaud's API; every requested URL is pushed to `calls`.
export function fakeFetch(calls = []) {
	return async (url, init = {}) => {
		calls.push(String(url));
		const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
		if (url === 'https://s3.example/complet.json') return new Response(transcript);
		if (String(url).endsWith('/access-token/refresh')) {
			assert.equal(init.method, 'POST');
			assert.equal(String(init.body), 'refresh_token=refresh1');
			return json({access_token: 'nouveau', refresh_token: 'refresh2', expires_in: 3600});
		}
		assert.match(init.headers.Authorization, /^Bearer (valide|nouveau)$/);
		const u = new URL(url);
		if (u.pathname === '/developer/api/open/third-party/files/') {
			return json({data: Object.values(files).map(({id, name, created_at, duration}) => ({id, name, created_at, duration})), page: 1});
		}
		const id = decodeURIComponent(u.pathname.split('/').pop());
		return files[id] ? json(files[id]) : json({detail: 'not found'}, 404);
	};
}

// A temporary home (Plaud CLI session) and vault, with two notes left by the old Plaud Sync plugin.
export async function setup({expired = false} = {}) {
	const root = await mkdtemp(join(tmpdir(), 'plaud-to-obsidian-'));
	const home = join(root, 'home');
	const vault = join(root, 'vault');
	await mkdir(join(home, '.plaud'), {recursive: true});
	await mkdir(join(vault, '.obsidian'), {recursive: true});
	await mkdir(join(vault, 'Plaud'), {recursive: true});
	const tokenFile = join(home, '.plaud', 'tokens.json');
	await writeFile(tokenFile, JSON.stringify({
		access_token: 'valide', refresh_token: 'refresh1', token_type: 'Bearer',
		expires_at: expired ? Date.now() - 1000 : Date.now() + 3600_000
	}));
	await writeFile(join(vault, 'Plaud', 'plaud-2026-10-01-appel-client.md'),
		'---\nsource: plaud\ntype: recording\nfile_id: ancienVide\n---\n\n## Summary\nNo summary available.\n');
	await writeFile(join(vault, 'Plaud', 'plaud-2026-09-01-vieux.md'),
		'---\nsource: plaud\ntype: recording\nfile_id: ancienComplet\n---\n\n## Summary\nUn vrai résumé.\n');
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.APPDATA = join(home, 'AppData', 'Roaming');
	delete process.env.XDG_CONFIG_HOME;
	return {root, home, vault, tokenFile};
}
