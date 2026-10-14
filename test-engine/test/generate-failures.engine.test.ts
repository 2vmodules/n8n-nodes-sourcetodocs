/**
 * Generate and its waits survive ordinary failures. One
 * case per failure, positive and negative, on n8n's own engine. Real time: a poll costs Poll Every
 * (2 s at least), so the cases that wait run concurrently.
 */
import { describe, expect, it } from 'vitest';
import type { INodeParameters } from 'n8n-workflow';

import {
	API_PATH,
	DOC_ID,
	DS_ID,
	documentPayload,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	s2dJson,
	useFakeApis,
	type FakeApi,
	type FakeReply,
	type RunOptions,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis({ concurrent: true });

const RUN_ID = 'b0000000-0000-4000-8000-000000000001';
const BATCH_ID = 'b0000000-0000-4000-8000-0000000000b1';
const retryAfter = (seconds: number): FakeReply => ({ ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': String(seconds) } });
const RESET: FakeReply = { status: -1 };

async function generate(api: FakeApi, node: TestNode, options: Partial<RunOptions> = {}, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items as never), node],
		connections: [['Emit', 'SourceToDocs']],
		...options,
	});
}
const waiting = (extra: INodeParameters = {}) => s2dConnected({ waitForCompletion: true, ...extra });

describe.concurrent('an Idempotency Key that is not text', () => {
	const keyOf = (api: FakeApi) => (api.posts()[0].body as { idempotency_key?: string }).idempotency_key;
	const start = (): Router => (request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'succeeded' }) }, 201) : failure(404, 'not_found', 'No.'));

	it('a number from an expression is used as its text', async () => {
		const api = await startApi(start());

		const result = await generate(api, s2dConnected({ idempotencyKey: '={{ 12345 }}' }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(keyOf(api)).toBe('12345');
	});

	it('a text key is used as it is (trimmed), and an empty one leaves the automatic key', async () => {
		const api = await startApi(start());
		const empty = await startApi(start());

		await generate(api, s2dConnected({ idempotencyKey: '={{ "  order-7 " }}' }));
		await generate(empty, s2dConnected({ idempotencyKey: '' }));

		expect(keyOf(api)).toBe('order-7');
		expect(keyOf(empty)).toMatch(/^n8n:/);
	});

	it.each([
		['nothing (a missing field)', '={{ $json.missing }}'],
		['a boolean', '={{ true }}'],
		['an object', '={{ ({ a: 1 }) }}'],
		['a number that is not finite', '={{ NaN }}'],
	])('%s stops Generate with a message naming Idempotency Key, and sends nothing', async (_title, expression) => {
		const api = await startApi(start());

		const result = await generate(api, s2dConnected({ idempotencyKey: expression }));

		const error = result.errorOf('SourceToDocs') as { name: string; message: string; description?: string } | undefined;
		expect(error?.name).toBe('NodeOperationError');
		expect(error?.message).toContain('Idempotency Key');
		expect(error?.message).not.toContain('trim');
		expect(error?.description).toContain('text or a number');
		expect(error?.description).toContain('Nothing was sent');
		expect(api.requests).toHaveLength(0);
	});
});

describe.concurrent('a dropped connection while waiting', () => {
	it('a reset poll is retried and the wait goes on', async () => {
		let polls = 0;
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ status: 'pending' }) }, 201);
			polls += 1;
			return polls === 1 ? RESET : ok({ run: runPayload({ status: 'succeeded' }) });
		});

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls).toBe(2);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
	});

	it('a connection that is reset again and again ends as timed out within Max Wait', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : RESET));

		const result = await generate(api, waiting({ maxWait: 4, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')[0]).toMatchObject({ run_id: RUN_ID, timed_out: true });
	});

	it('a 404 on a poll is still an error, naming the run', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : failure(404, 'not_found', 'Resource not found.')));

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		const error = result.errorOf('SourceToDocs') as { description?: string; httpCode?: string };
		expect(error.httpCode).toBe('404');
		expect(error.description).toContain(`Run ID: ${RUN_ID}`);
	});
});

describe.concurrent('a transient answer on the last poll', () => {
	const router = (poll: FakeReply): Router => (request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : poll);

	it.each([
		['a 500', failure(500, 'generic', 'Server error.')],
		['a 429', failure(429, 'generic', 'Too Many Attempts.')],
		['a connection reset', RESET],
	])('%s on the poll with no budget left is a timed-out item, not an error', async (_title, reply) => {
		const api = await startApi(router(reply));

		const result = await generate(api, waiting({ maxWait: 2, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_ID, status: 'pending', timed_out: true })]);
	});

	it('a 404 on the last poll is an error all the same', async () => {
		const api = await startApi(router(failure(404, 'not_found', 'Resource not found.')));

		const result = await generate(api, waiting({ maxWait: 2, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeDefined();
	});
});

describe.concurrent('empty_rows is counted on what is sent', () => {
	const router: Router = (request) =>
		request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`
			? ok(documentFixture())
			: ok({ run: runPayload({ status: 'succeeded' }) }, 201);

	it('a row that Unknown Fields: Drop emptied is counted and sent blank', async () => {
		const api = await startApi(router);

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: [{ 'Client Name': 'Acme' }, { 'Client name': 'Globex' }] }]));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')[0]).toMatchObject({ empty_rows: 1, dropped_keys: { [DS_ID]: ['Client Name'] } });
		expect(api.posts()[0].body).toMatchObject({ inline_data: { [DS_ID]: [{}, { 'Client name': 'Globex' }] } });
		expect(result.hintsOf('SourceToDocs').map((hint) => hint.message).join(' ')).toContain('1 row(s) had no fields');
	});

	it('rows that all keep a column are not counted', async () => {
		const api = await startApi(router);

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: [{ 'Client name': 'Acme', Extra: 1 }] }]));

		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_rows');
	});
});

describe.concurrent('the two reads honour 429 and Retry-After', () => {
	it('the document read inside Generate is retried after the Retry-After it names', async () => {
		let reads = 0;
		const api = await startApi((request) => {
			if (request.method === 'GET') {
				reads += 1;
				return reads === 1 ? retryAfter(1) : ok(documentFixture());
			}
			return ok({ run: runPayload({ status: 'succeeded' }) }, 201);
		});

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: [{ 'Client name': 'Acme' }] }]));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(reads).toBe(2);
		expect(api.posts()).toHaveLength(1);
		expect(result.ms).toBeGreaterThanOrEqual(900);
	});

	it('a 404 on the document read is not retried', async () => {
		const api = await startApi((request) => (request.method === 'GET' ? failure(404, 'not_found', 'Resource not found.') : ok({ run: runPayload() }, 201)));

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: [{ 'Client name': 'Acme' }] }]));

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		expect(api.gets()).toHaveLength(1);
		expect(api.posts()).toHaveLength(0);
	});

	it('the batch children list is retried after a 429 instead of failing a finished wait', async () => {
		let lists = 0;
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: BATCH_ID, kind: 'batch', status: 'succeeded', file_count: 1 }) }, 201);
			lists += 1;
			return lists === 1 ? retryAfter(1) : ok({ runs: [runPayload({ id: 'child-1', split_key: 'Acme', status: 'succeeded' })] });
		});

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(lists).toBe(2);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: 'child-1', batch_run_id: BATCH_ID })]);
	});
});

describe.concurrent('a stopped execution stops the wait', () => {
	it('a long Poll Every ends within a second of the stop', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : ok({ run: runPayload({ status: 'processing' }) })));

		const result = await generate(api, waiting({ maxWait: 3600, pollEvery: 60 }), { cancelAfterMs: 500 });

		expect(result.ms).toBeLessThan(1500);
		expect(api.gets()).toHaveLength(0);
	});

	it('a poll Retry-After wait ends within a second of the stop', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : retryAfter(60)));

		const result = await generate(api, waiting({ maxWait: 3600, pollEvery: 2 }), { cancelAfterMs: 3000 });

		expect(result.ms).toBeLessThan(4500);
		expect(api.gets()).toHaveLength(1);
	});

	it('the start request Retry-After wait ends within a second of the stop', async () => {
		const api = await startApi(() => retryAfter(60));

		const result = await generate(api, waiting({ maxWait: 3600, pollEvery: 2 }), { cancelAfterMs: 500 });

		expect(result.ms).toBeLessThan(1500);
		expect(api.posts()).toHaveLength(1);
	});

	it('an execution that is not stopped waits its whole Poll Every (the control)', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : ok({ run: runPayload({ status: 'succeeded' }) })));

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		expect(result.ms).toBeGreaterThanOrEqual(1900);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
	});
});

describe.concurrent('the start request Retry-After has a 1 s floor', () => {
	it('a Retry-After of 0 is not retried at once', async () => {
		const times: number[] = [];
		const api = await startApi((request) => {
			if (request.method !== 'POST') return failure(404, 'not_found', 'No.');
			times.push(Date.now());
			return times.length === 1 ? retryAfter(0) : ok({ run: runPayload({ status: 'succeeded' }) }, 201);
		});

		const result = await generate(api, s2dConnected());

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(times).toHaveLength(2);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(950);
	});

	it('a Retry-After longer than the floor is still honoured', async () => {
		const times: number[] = [];
		const api = await startApi((request) => {
			if (request.method !== 'POST') return failure(404, 'not_found', 'No.');
			times.push(Date.now());
			return times.length === 1 ? retryAfter(2) : ok({ run: runPayload({ status: 'succeeded' }) }, 201);
		});

		await generate(api, s2dConnected());

		expect(times[1] - times[0]).toBeGreaterThanOrEqual(1950);
	});
});

/** The document fixture the document read answers with. */
function documentFixture() {
	return documentPayload.data;
}

describe.concurrent('a 429 that refuses the API Token is not retried', () => {
	const refused = (): FakeReply => failure(429, 'authentication', 'Too many failed authentication attempts.', { code: ['authentication_rate_limited'] });
	const named = (message: string | undefined) => {
		expect(message).toContain("'API Token'");
		expect(message).toContain('too many times');
	};

	it('the start request is sent once, with a key, and the message names the token', async () => {
		const api = await startApi(() => refused());

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		expect(api.posts()).toHaveLength(1);
		named(result.errorOf('SourceToDocs')?.message);
		expect(result.ms).toBeLessThan(1500);
	});

	it('a poll is read once and stops the wait at once', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : refused()));

		const result = await generate(api, waiting({ maxWait: 60, pollEvery: 2 }));

		expect(api.gets()).toHaveLength(1);
		named(result.errorOf('SourceToDocs')?.message);
		expect(result.ms).toBeLessThan(5000);
	});

	it('the document read inside Generate is sent once', async () => {
		const api = await startApi((request) => (request.method === 'GET' ? refused() : ok({ run: runPayload({ status: 'succeeded' }) }, 201)));

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: [{ 'Client name': 'Acme' }] }]));

		expect(api.gets()).toHaveLength(1);
		expect(api.posts()).toHaveLength(0);
		named(result.errorOf('SourceToDocs')?.message);
	});

	it('the control: a 429 without the code is still retried', async () => {
		let polls = 0;
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ status: 'pending' }) }, 201);
			polls += 1;
			return polls === 1 ? retryAfter(1) : ok({ run: runPayload({ status: 'succeeded' }) });
		});

		const result = await generate(api, waiting({ maxWait: 20, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls).toBe(2);
	});
});

describe.concurrent('Run → Get has the wait bounds of Generate', () => {
	const batch = runPayload({ id: BATCH_ID, kind: 'batch', status: 'succeeded', file_count: 1 });
	const router = (children: () => FakeReply): Router => (request) => (request.path.endsWith('/children') ? children() : ok({ run: batch }));
	const get = (api: FakeApi, extra: INodeParameters) =>
		runWorkflow({ baseUrl: api.baseUrl, nodes: [emit([{ json: {} }] as never), s2d({ resource: 'run', operation: 'get', runId: BATCH_ID, ...extra }, { typeVersion: 1.1 })], connections: [['Emit', 'SourceToDocs']] });

	it('a children list that keeps answering 429 ends within Max Wait, here raised to its 5 s floor', async () => {
		const api = await startApi(router(() => retryAfter(1)));

		const result = await get(api, { maxWait: 1 });

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		expect(result.ms).toBeGreaterThanOrEqual(4000);
		expect(result.ms).toBeLessThan(15000);
		expect(api.gets().filter((request) => request.path.endsWith('/children')).length).toBeGreaterThanOrEqual(3);
	});

	it('a Max Wait that is not a number is refused before anything is sent', async () => {
		const api = await startApi(router(() => ok({ runs: [] })));

		const result = await get(api, { maxWait: "={{ 'soon' }}" });

		expect(result.errorOf('SourceToDocs')?.message).toContain("'Max Wait (Seconds)'");
		expect(api.requests).toHaveLength(0);
	});

	it('the default reads the list once and answers', async () => {
		const api = await startApi(router(() => ok({ runs: [runPayload({ id: 'child-1', split_key: 'Acme', status: 'succeeded' })] })));

		const result = await get(api, {});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toHaveLength(1);
	});
});
