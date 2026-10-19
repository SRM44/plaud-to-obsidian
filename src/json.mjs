import {readFile, rename, writeFile} from 'node:fs/promises';
import {PlaudSyncError} from './errors.mjs';

export async function readJson(path, fallback) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return fallback;
		throw new PlaudSyncError('config', `Cannot read ${path} (${err.message})`);
	}
}

export async function writeJsonAtomic(path, value, mode) {
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode});
	await rename(tmp, path);
}

