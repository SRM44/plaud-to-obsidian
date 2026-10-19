// Bundles plugin/main.mjs and src/core.mjs into the single CommonJS file Obsidian loads
// (dist/main.js), without any dependency. It relies on the sources' simple style: one-line
// `import {a, b} from 'module';` statements, and `export` only in front of declarations.

import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$/gm;

function strip(source, imports) {
	let defaultClass = null;
	const body = source
		.replace(IMPORT, (_, names, from) => {
			if (!from.startsWith('.')) {
				const module = from.replace(/^node:/, '');
				const set = imports.get(module) ?? new Set();
				for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) set.add(name);
				imports.set(module, set);
			}
			return '';
		})
		.replace(/^export default class (\w+)/m, (_, name) => {
			defaultClass = name;
			return `class ${name}`;
		})
		.replace(/^export (?=(async )?function |class |const |let )/gm, '');

	const leftover = /^(import|export)\b.*$/m.exec(body);
	if (leftover) throw new Error(`Unsupported module syntax: ${leftover[0]}`);
	return {body: body.trim(), defaultClass};
}

export async function buildPlugin(outDir = join(root, 'dist')) {
	const imports = new Map();
	const core = strip(await readFile(join(root, 'src', 'core.mjs'), 'utf8'), imports);
	const plugin = strip(await readFile(join(root, 'plugin', 'main.mjs'), 'utf8'), imports);
	if (!plugin.defaultClass) throw new Error('plugin/main.mjs must `export default class`.');

	const manifest = JSON.parse(await readFile(join(root, 'plugin', 'manifest.json'), 'utf8'));
	const requires = [...imports].map(([module, names]) => `const {${[...names].join(', ')}} = require('${module}');`);
	const output = [
		`/* ${manifest.name} ${manifest.version} — built from src/core.mjs and plugin/main.mjs, do not edit. */`,
		"'use strict';",
		...requires,
		'',
		core.body,
		'',
		plugin.body,
		'',
		`module.exports = ${plugin.defaultClass};`,
		''
	].join('\n');

	await mkdir(outDir, {recursive: true});
	await writeFile(join(outDir, 'main.js'), output, 'utf8');
	await copyFile(join(root, 'plugin', 'manifest.json'), join(outDir, 'manifest.json'));
	return join(outDir, 'main.js');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.log(`Built ${await buildPlugin()}`);
}
