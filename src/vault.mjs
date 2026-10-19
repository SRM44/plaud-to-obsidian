import {copyFile, mkdir, readdir, readFile, rename, unlink, writeFile, realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep, win32} from 'node:path';
import {PlaudSyncError} from './errors.mjs';
import {idKey} from './utils.mjs';

// Check traversal and existing symlinks, including a missing leaf's ancestors.
export async function resolveVaultFolder(vaultPath, folder) {
	if (isAbsolute(folder) || win32.isAbsolute(folder) || folder.split(/[/\\]/).includes('..')) {
		throw new PlaudSyncError('config', `Folder must stay inside the vault: ${folder}`);
	}
	const vault = await realpath(vaultPath);
	const target = resolve(vault, folder);
	let ancestor = target;
	for (;;) {
		try {
			const rel = relative(vault, await realpath(ancestor));
			if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
				throw new PlaudSyncError('config', `Folder points outside the vault: ${folder}`);
			}
			break;
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw err;
			ancestor = parent;
		}
	}
	return resolve(vaultPath, folder);
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
export async function indexExistingNotes(folder) {
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

export async function writeNewNote(folder, fileName, text) {
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

export async function moveToBackup(path, backupDir) {
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

