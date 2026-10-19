import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, stat, rm, utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {setup} from './helpers.mjs';
import {acquireLock} from '../src/lock.mjs';

const options = {stale: 2000, update: 1000};

test('active leases refresh their mtime and refuse a concurrent import', async () => {
	const {vault} = await setup();
	const file = join(vault, '.obsidian', 'state.json');
	const lease = await acquireLock(file, options);
	try {
		const initial = (await stat(`${file}.lock`)).mtimeMs;
		await delay(1600);
		assert.ok((await stat(`${file}.lock`)).mtimeMs > initial);
		await assert.rejects(acquireLock(file, options), (err) => err.kind === 'busy');
		lease.assertOwned();
	} finally { await lease.release(); }
	const next = await acquireLock(file, options);
	await next.release();
});

test('abandoned locks can be recovered', async () => {
	const {vault} = await setup();
	const file = join(vault, '.obsidian', 'state.json');
	await mkdir(`${file}.lock`);
	await utimes(`${file}.lock`, new Date(0), new Date(0));
	const lease = await acquireLock(file, options);
	await lease.release();
});

test('lost leases stop writes and do not remove a replacement lock', async () => {
	const {vault} = await setup();
	const file = join(vault, '.obsidian', 'state.json');
	const lease = await acquireLock(file, options);
	try {
		await rm(`${file}.lock`, {recursive: true});
		await mkdir(`${file}.lock`);
		await utimes(`${file}.lock`, new Date(0), new Date(0));
		await delay(1600);
		assert.throws(() => lease.assertOwned(), (err) => err.kind === 'busy');
		await lease.release();
		assert.ok((await stat(`${file}.lock`)).isDirectory());
	} finally {
		await lease.release();
		await rm(`${file}.lock`, {recursive: true, force: true});
	}
});
