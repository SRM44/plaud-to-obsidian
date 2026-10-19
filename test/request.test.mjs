import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForRequest} from '../src/request.mjs';

test('a stalled request stops waiting on abort, and late failures are handled', async () => {
	const controller = new AbortController();
	let fail;
	const pending = waitForRequest(() => new Promise((_, reject) => { fail = reject; }), controller.signal);
	await Promise.resolve();
	controller.abort(new Error('timeout'));
	await assert.rejects(pending, /timeout/);
	fail(new Error('late failure'));
	await new Promise((resolve) => setImmediate(resolve));
});

test('already aborted signals skip the request, completed requests remove their listener', async () => {
	const controller = new AbortController();
	assert.equal(await waitForRequest(() => 42, controller.signal), 42);
	controller.abort(new Error('aborted'));
	await assert.rejects(waitForRequest(() => { throw new Error('must not run'); }, controller.signal), /aborted/);
});
