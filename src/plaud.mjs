import {homedir} from 'node:os';
import {join} from 'node:path';
import {PlaudSyncError} from './errors.mjs';
import {readJson, writeJsonAtomic} from './json.mjs';
import {sleep} from './utils.mjs';

export const DEFAULT_API_BASE = 'https://platform.plaud.ai/developer/api';
export const defaultTokenFile = () => join(homedir(), '.plaud', 'tokens.json');
const PAGE_SIZE = 100;
const RATE_LIMIT_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

// --- Plaud session (same token file and refresh flow as the official CLI) ---

export async function readPlaudLogin(tokenFile = defaultTokenFile()) {
	const tokens = await readJson(tokenFile, null).catch(() => null);
	return {loggedIn: Boolean(tokens?.access_token), tokenFile};
}

export async function getAccessToken(ctx) {
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
	// OAuth servers answer 400 (invalid_grant) for an expired or revoked refresh token.
	if (res.status === 400 || res.status === 401 || res.status === 403) {
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

export async function api(path, token, ctx) {
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

export async function listAllFiles(token, sinceMs, ctx) {
	const files = [];
	for (let page = 1; page <= 1000; page++) {
		const params = new URLSearchParams({page: String(page), page_size: String(PAGE_SIZE)});
		if (sinceMs !== undefined) params.set('start_date', String(sinceMs));
		const result = await api(`/open/third-party/files/?${params}`, token, ctx);
		const data = Array.isArray(result?.data) ? result.data : [];
		files.push(...data);
		// The server may cap the page size: compare with the size it reports, not the one asked for.
		const pageSize = Number(result?.page_size) || PAGE_SIZE;
		if (data.length === 0 || data.length < pageSize) break;
	}
	return files;
}

export async function blockText(block, ctx) {
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

