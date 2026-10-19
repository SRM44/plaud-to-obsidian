import {copyFile, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPlugin(outDir = join(root, 'dist')) {
	await mkdir(outDir, {recursive: true});
	const output = join(outDir, 'main.js');
	await build({
		entryPoints: [join(root, 'plugin', 'main.mjs')], outfile: output,
		bundle: true, platform: 'node', format: 'cjs', target: 'node18',
		external: ['obsidian'], footer: {js: 'module.exports = module.exports.default;'}
	});
	await copyFile(join(root, 'plugin', 'manifest.json'), join(outDir, 'manifest.json'));
	return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.log(`Built ${await buildPlugin()}`);
}
