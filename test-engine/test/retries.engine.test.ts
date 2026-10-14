/**
 * A retry never starts a second run, and waiting is bounded whatever an expression gives.
 * Through n8n's own engine.
 *
 * The fake API here keeps the backend's one promise that matters: a second start with a key it has
 * already seen is `422 run_idempotency_conflict` carrying `errors.run_id`, and creates nothing. It
 * can also lose an answer after creating the run (a 500, or no answer at all), which is exactly
 * what makes a retry dangerous.
 *
 * Real time: Retry On Fail waits about 1 s per try even with `waitBetweenTries: 0`, and a poll costs
 * Poll Every (2 s at least), so the cases that need them are few and run concurrently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INodeParameters } from 'n8n-workflow';

import {
	API_PATH,
	DOC_ID,
	DS_ID,
	documentPayload,
	bodyOf,
	emit,
	failure,
	ok,
	probeLog,
	runPayload,
	runAsTool,
	runWorkflow,
	s2dConnected,
	s2d,
	s2dMapped,
	transportLimits,
	useFakeApis,
	type FakeApi,
	type FakeReply,
	type TestNode,
	type Router,
} from './harness';

const startApi = useFakeApis({ concurrent: true });

const originalLimits = { ...transportLimits };
beforeAll(() => {
	transportLimits.requestTimeoutMs = 1000;
	transportLimits.startRetryBackoffMs = 50;
});
afterAll(() => {
	Object.assign(transportLimits, originalLimits);
});

const RUN_1 = 'b0000000-0000-4000-8000-000000000001';
const runId = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;

/** What the n-th start POST does: create the run and answer, create it and lose the answer, or answer with a reply and create nothing. */
type Outcome = 'ok' | 'lost-500' | 'lost-hang' | FakeReply;

interface BackendOptions {
	/** Per start POST, in order; the rest are 'ok'. */
	posts?: Outcome[];
	/** The status every run reads as. */
	status?: string;
	/** The status of the n-th run created (1-based); wins over `status`. */
	statusOf?: (runNumber: number) => string;
	/** When the n-th run created (1-based) was created, as the API's `created_at`. Default: now. */
	createdAt?: (runNumber: number) => string;
	/** `batch` makes every run a batch. */
	kind?: 'single' | 'batch';
	/** Overrides the n-th (1-based) read of a run. */
	getRun?: (n: number) => FakeReply | undefined;
	/** The `errors` of the conflict. Default: the code, the run id and the key, as the backend sends them. */
	conflictErrors?: (key: string, id: string) => unknown;
}

function backend(options: BackendOptions = {}) {
	const runs = new Map<string, string>();
	const statusFor = (id: string) => options.statusOf?.(Number(id.slice(-1))) ?? options.status ?? 'pending';
	const payload = (id: string) =>
		runPayload({ id, status: statusFor(id), kind: options.kind ?? 'single', created_at: options.createdAt?.(Number(id.slice(-1))) ?? new Date().toISOString() });
	const state = { posts: 0, gets: 0, created: 0, postTimes: [] as number[] };
	const router: Router = (request) => {
		if (request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(documentPayload.data);
		if (request.method === 'POST' && request.path === `${API_PATH}/documents/${DOC_ID}/runs`) {
			const outcome = options.posts?.[state.posts] ?? 'ok';
			state.posts += 1;
			state.postTimes.push(Date.now());
			if (typeof outcome === 'object') return outcome;
			const key = (request.body as { idempotency_key?: string } | undefined)?.idempotency_key;
			if (key !== undefined && runs.has(key)) {
				const id = runs.get(key) as string;
				const errors = options.conflictErrors?.(key, id) ?? { code: 'run_idempotency_conflict', run_id: id, idempotency_key: key };
				return failure(422, 'generic', 'A run with this idempotency key already exists.', errors);
			}
			state.created += 1;
			const id = runId(state.created);
			if (key !== undefined) runs.set(key, id);
			if (outcome === 'lost-500') return failure(500, 'generic', 'Server Error');
			if (outcome === 'lost-hang') return { status: 0 };
			return ok({ run: payload(id) }, 201);
		}
		if (request.method === 'GET' && request.path.startsWith(`${API_PATH}/runs/`)) {
			state.gets += 1;
			const override = options.getRun?.(state.gets);
			if (override !== undefined) return override;
			const id = request.path.split('/').pop() as string;
			return ok({ run: payload(id) });
		}
		return failure(404, 'not_found', 'Resource not found.');
	};
	return { state, router };
}

const succeededRun = (id = RUN_1) =>
	ok({ run: runPayload({ id, status: 'succeeded', created_at: new Date().toISOString(), output_result: { document_url: 'https://docs.google.com/d/1', document_name: 'Invoice' } }) });

const keyOf = (request: { body: unknown }) => (request.body as { idempotency_key?: string }).idempotency_key;

async function generate(api: FakeApi, parameters: INodeParameters = {}, extra: Partial<TestNode> = {}, run: { executionId?: string } = {}) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		executionId: run.executionId,
		nodes: [emit([{ json: {} }]), s2dConnected(parameters, extra)],
		connections: [['Emit', 'SourceToDocs']],
	});
}

const retrying = { retryOnFail: true, maxTries: 3, waitBetweenTries: 0 };

describe.concurrent('The automatic key', () => {
	it('is n8n:<instance>:<workflow>:<execution>:<node>:<run index>, and is sent when the field is empty', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		await generate(api, {}, {}, { executionId: '7' });

		expect(keyOf(api.posts()[0])).toMatch(/^n8n:[0-9a-f]{16}:engine-test:7:node-1:0$/);
		expect(bodyOf(api.posts()[0])).toBeUndefined();
	});

	it('differs for the two runs of the node in one execution', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		await runWorkflow({
			baseUrl: api.baseUrl,
			start: 'Trigger',
			nodes: [
				emit([{ json: {} }], 'Trigger'),
				emit([{ json: { 'Client name': 'A1' } }], 'A'),
				emit([{ json: { 'Client name': 'B1' } }], 'B'),
				s2dMapped({ 'Client name': '={{ $json["Client name"] }}' }),
			],
			connections: [['Trigger', 'A'], ['Trigger', 'B'], ['A', 'SourceToDocs'], ['B', 'SourceToDocs']],
		});

		const keys = api.posts().map(keyOf);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		expect(keys[0]).toMatch(/:node-3:0$/);
		expect(keys[1]).toMatch(/:node-3:1$/);
	});

	it('differs for two executions of the same workflow', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		await generate(api, {}, {}, { executionId: '101' });
		await generate(api, {}, {}, { executionId: '102' });

		const keys = api.posts().map(keyOf);
		expect(new Set(keys).size).toBe(2);
		expect(keys[0]).toContain(':101:');
		expect(keys[1]).toContain(':102:');
	});

	it('differs for two nodes of one execution', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), s2dConnected({}, { name: 'First' }), s2dConnected({}, { name: 'Second' })],
			connections: [['Emit', 'First'], ['Emit', 'Second']],
		});

		expect(new Set(api.posts().map(keyOf)).size).toBe(2);
	});

	it('never passes 255 characters, whatever the ids look like', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		const result = await generate(api, {}, { id: 'n'.repeat(300) }, { executionId: '9'.repeat(300) });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		const key = keyOf(api.posts()[0]) as string;
		expect(key.length).toBeLessThanOrEqual(255);
		expect(key.startsWith('n8n:')).toBe(true);
	});

	it('is not sent when the engine gives no execution id (a key that cannot tell executions apart would adopt an old run)', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		await generate(api, {}, {}, { executionId: '' });

		expect(api.posts()[0].body).toBeUndefined();
	});

	it('is the same on every Retry On Fail try, and different for another run, execution or node (measured on the engine)', async () => {
		probeLog.length = 0;
		await runWorkflow({
			baseUrl: 'http://127.0.0.1:9',
			executionId: '55',
			nodes: [
				emit([{ json: {} }]),
				{ name: 'Probe', type: 'test.probe', parameters: { failFirst: 2 }, ...retrying },
				{ name: 'Other', type: 'test.probe', parameters: {} },
			],
			connections: [['Emit', 'Probe'], ['Probe', 'Other']],
		});

		const [first, second, third, other] = probeLog;
		expect(probeLog).toHaveLength(4);
		expect([second, third]).toEqual([first, first]);
		expect(first).toMatchObject({ executionId: '55', nodeId: 'node-1', runIndex: 0 });
		expect(other).toMatchObject({ executionId: '55', nodeId: 'node-2', runIndex: 0 });
		expect(typeof first.instanceId).toBe('string');
	});
});

describe.concurrent('Retry On Fail resumes the run', () => {
	const variants: Array<{ title: string; parameters: INodeParameters }> = [
		{ title: 'with the automatic key', parameters: {} },
		{ title: 'with a key the person set', parameters: { idempotencyKey: 'invoice-2026-10' } },
	];

	it.each(variants)('a run that ends failed is followed by one new run, then adopted or chained again, $title', async ({ parameters }) => {
		const fake = backend({ statusOf: (n) => (n === 1 ? 'failed' : 'succeeded') });
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, maxWait: 30, pollEvery: 2, ...parameters }, retrying);

		const first = keyOf(api.posts()[0]) as string;
		if (parameters.idempotencyKey !== undefined) expect(first).toBe(parameters.idempotencyKey);
		// Try 1 creates run 1, which ends failed. Try 2 meets that conflict and starts run 2 under the derived key.
		expect(api.posts().map(keyOf)).toEqual([first, first, `${first}:after:${RUN_1}`]);
		expect(fake.state.created).toBe(2);
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: runId(2), status: 'succeeded' })]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('idempotent_replay');
	});

	it.each(variants)('runs that keep failing chain the keys, one new run per try, three at most, $title', async ({ parameters }) => {
		const fake = backend({ status: 'failed' });
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, ...parameters }, retrying);

		const first = keyOf(api.posts()[0]) as string;
		const second = `${first}:after:${runId(1)}`;
		const third = `${second}:after:${runId(2)}`;
		expect(api.posts().map(keyOf)).toEqual([first, first, second, first, second, third]);
		expect(fake.state.created).toBe(3);
		const error = result.errorOf('SourceToDocs');
		expect(error?.description).toContain(`Run ID: ${runId(3)}`);
	});

	it.each(variants)('a poll answering 401 is retried onto the same run, which then finishes, $title', async ({ parameters }) => {
		const fake = backend({
			status: 'processing',
			getRun: (n) => (n === 1 ? failure(401, 'auth', 'Invalid API token.') : succeededRun()),
		});
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, maxWait: 30, pollEvery: 2, ...parameters }, retrying);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(fake.state.created).toBe(1);
		expect(api.posts()).toHaveLength(2);
		expect(new Set(api.posts().map(keyOf)).size).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ run_id: RUN_1, status: 'succeeded', file_url: 'https://docs.google.com/d/1', idempotent_replay: true }),
		]);
	});

	it('an ordinary first start is not marked idempotent_replay', async () => {
		const api = await startApi(backend({ status: 'succeeded' }).router);

		const result = await generate(api, { waitForCompletion: true });

		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('idempotent_replay');
	});
});

describe.concurrent('The status of the run a conflict names decides', () => {
	it.each(['pending', 'processing', 'succeeded', 'partial_success'])('a %s run is adopted and no new run is started', async (status) => {
		const fake = backend({ status });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' });

		expect(fake.state.created).toBe(1);
		expect(api.posts().map(keyOf)).toEqual(['monthly', 'monthly']);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, status, idempotent_replay: true })]);
	});

	it('a failed run under a key the person set is followed by <key>:after:<run id>', async () => {
		const fake = backend({ statusOf: (n) => (n === 1 ? 'failed' : 'succeeded') });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' });

		expect(api.posts().map(keyOf)).toEqual(['monthly', 'monthly', `monthly:after:${RUN_1}`]);
		expect(fake.state.created).toBe(2);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: runId(2), status: 'succeeded' })]);
	});

	it('a failed batch is chained like a single run (a failed batch means every child failed, so no file was delivered)', async () => {
		const fake = backend({ kind: 'batch', statusOf: (n) => (n === 1 ? 'failed' : 'pending') });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' });

		expect(api.posts().map(keyOf)).toEqual(['monthly', 'monthly', `monthly:after:${RUN_1}`]);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: runId(2), kind: 'batch' })]);
	});
});

describe.concurrent('A conflict that names the run', () => {
	it('is adopted without waiting: the run is read and returned, marked idempotent_replay (a key the person set)', async () => {
		const fake = backend({ status: 'succeeded' });
		const api = await startApi(fake.router);
		// The key already holds a run from an earlier execution.
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' });

		expect(fake.state.created).toBe(1);
		expect(api.posts().map(keyOf)).toEqual(['monthly', 'monthly']);
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
		expect(api.gets().map((g) => g.path)).toEqual([`${API_PATH}/runs/${RUN_1}`]);
	});

	it('is adopted and then waited for when Wait For Completion is on', async () => {
		const fake = backend({
			status: 'processing',
			getRun: (n) => (n === 1 ? undefined : succeededRun()),
		});
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly', waitForCompletion: true, maxWait: 30, pollEvery: 2 });

		expect(fake.state.created).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ run_id: RUN_1, status: 'succeeded', file_url: 'https://docs.google.com/d/1', idempotent_replay: true }),
		]);
		// One read to adopt, one poll.
		expect(api.gets()).toHaveLength(2);
	});

	it('without errors.run_id stays the conflict error, and is not retried', async () => {
		const fake = backend({ conflictErrors: () => ({ code: 'run_idempotency_conflict' }) });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' }, { onError: 'continueRegularOutput' });

		expect(api.posts()).toHaveLength(2);
		expect(api.gets()).toHaveLength(0);
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ error: 'A run with this idempotency key already exists.', error_code: 'run_idempotency_conflict' }),
		]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('run_id');
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('idempotent_replay');
	});

	it('with a run_id that is not an id stays the error, shows that run_id, and reads nothing', async () => {
		const fake = backend({ conflictErrors: (key) => ({ code: 'run_idempotency_conflict', run_id: '../../projects', idempotency_key: key }) });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' }, { onError: 'continueRegularOutput' });

		expect(api.gets()).toHaveLength(0);
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ error_code: 'run_idempotency_conflict', run_id: '../../projects' }),
		]);
	});

	it('is an error naming the run when that run cannot be read', async () => {
		const fake = backend({ getRun: () => failure(404, 'not_found', 'Resource not found.') });
		const api = await startApi(fake.router);
		await generate(api, { idempotencyKey: 'monthly' });

		const result = await generate(api, { idempotencyKey: 'monthly' }, { onError: 'continueRegularOutput' });

		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ error: 'Resource not found.', run_id: RUN_1 })]);
	});
});

describe.concurrent('Retrying the start POST', () => {
	it('a 429 is retried after the Retry-After it names, with the same key', async () => {
		const fake = backend({
			status: 'succeeded',
			posts: [{ ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '1' } }],
		});
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(2);
		expect(new Set(api.posts().map(keyOf)).size).toBe(1);
		expect(fake.state.created).toBe(1);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('idempotent_replay');
		// Retry-After: 1 is 1 s. Not heard it: ~50 ms (under 950). Read as 2 s or more: over 2400.
		expect(result.ms).toBeGreaterThanOrEqual(950);
		expect(result.ms).toBeLessThan(2400);
	});

	it('a 429 without Retry-After is retried after a short backoff', async () => {
		const fake = backend({ status: 'succeeded', posts: [failure(429, 'generic', 'Too Many Attempts.')] });
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(2);
		// The gap between the two POSTs is the backoff alone (50 ms here, 1000 ms in production), so
		// start-up noise of the engine does not count against the bound.
		const [first, second] = fake.state.postTimes;
		expect(second - first).toBeLessThan(600);
	});

	it('a 500 that lost the answer is retried with the same key, and the conflict adopts the run', async () => {
		const fake = backend({ status: 'succeeded', posts: ['lost-500'] });
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(fake.state.created).toBe(1);
		expect(api.posts()).toHaveLength(2);
		expect(new Set(api.posts().map(keyOf)).size).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
	});

	it('a timeout that lost the answer is retried with the same key, and the conflict adopts the run', async () => {
		const fake = backend({ status: 'succeeded', posts: ['lost-hang'] });
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(fake.state.created).toBe(1);
		expect(api.posts()).toHaveLength(2);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
	});

	it('a refused connection is retried too, and then surfaces as the error', async () => {
		// Nothing listens on port 9: every try is refused.
		const result = await runWorkflow({
			baseUrl: 'http://127.0.0.1:9/api/public/v1',
			nodes: [emit([{ json: {} }]), s2dConnected()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.errorOf('SourceToDocs')?.message).toMatch(/refused the connection/);
		// 50 ms then 100 ms of backoff: three tries happened.
		expect(result.ms).toBeGreaterThanOrEqual(140);
	});

	it.each([401, 404, 413, 422])('a %i is never retried', async (status) => {
		const fake = backend({ posts: [failure(status, 'validation', 'No.', { code: ['inline_data_set_unknown'] })] });
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(api.posts()).toHaveLength(1);
		expect(result.errorOf('SourceToDocs')?.message).toBe('No.');
	});

	it('gives up after 3 tries and throws the last answer', async () => {
		const fake = backend({ posts: ['lost-500', failure(500, 'generic', 'Second.'), failure(500, 'generic', 'Third.'), failure(500, 'generic', 'Fourth.')] });
		const api = await startApi(fake.router);

		const result = await generate(api);

		expect(api.posts()).toHaveLength(3);
		expect(result.errorOf('SourceToDocs')?.message).toBe('Third.');
	});

	it('a 429 whose Retry-After does not fit in Max Wait is the error: no wait, no second try', async () => {
		const fake = backend({ posts: [{ ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '30' } }] });
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, maxWait: 5, pollEvery: 2 });

		expect(api.posts()).toHaveLength(1);
		expect(result.errorOf('SourceToDocs')?.message).toBe('Too Many Attempts.');
		expect(result.ms).toBeLessThan(1500);
	});

	it('without an execution id (so without a key) a 429 is retried but a 500 is not', async () => {
		const throttled = backend({ status: 'succeeded', posts: [failure(429, 'generic', 'Too Many Attempts.')] });
		const throttledApi = await startApi(throttled.router);
		const broken = backend({ posts: [failure(500, 'generic', 'Server Error')] });
		const brokenApi = await startApi(broken.router);

		const retried = await generate(throttledApi, {}, {}, { executionId: '' });
		const failed = await generate(brokenApi, {}, {}, { executionId: '' });

		expect(retried.errorOf('SourceToDocs')).toBeUndefined();
		expect(throttledApi.posts()).toHaveLength(2);
		expect(failed.errorOf('SourceToDocs')?.message).toBe('Server Error');
		expect(brokenApi.posts()).toHaveLength(1);
	});
});

describe.concurrent('Max Wait and Poll Every are bounded whatever an expression gives', () => {
	const processingTwice = () =>
		backend({
			status: 'processing',
			getRun: (n) => (n >= 2 ? succeededRun() : undefined),
		});

	it('an empty expression takes the defaults: one poll per 5 s, not a tight loop', async () => {
		const fake = processingTwice();
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, maxWait: '={{ $json.nothing }}', pollEvery: '={{ $json.nothing }}' });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		expect(api.gets()).toHaveLength(2);
		// Two polls, each after the default 5 s.
		expect(result.ms).toBeGreaterThanOrEqual(9900);
	});

	it.each([
		['Max Wait (Seconds)', { maxWait: "={{ 'soon' }}" }],
		['Poll Every (Seconds)', { pollEvery: "={{ 'often' }}" }],
		['Max Wait (Seconds)', { maxWait: '={{ NaN }}' }],
		['Poll Every (Seconds)', { pollEvery: '={{ Infinity }}' }],
		['Max Wait (Seconds)', { maxWait: '={{ [1] }}' }],
	])('a value that is not a number is refused naming %s, before anything is sent', async (parameter, values) => {
		const fake = backend();
		const api = await startApi(fake.router);

		const result = await generate(api, { waitForCompletion: true, ...values });

		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeOperationError');
		expect(error?.message).toContain(`'${parameter}' is not a number`);
		expect(api.requests).toEqual([]);
	});

	it('is not read at all when the node does not wait', async () => {
		const api = await startApi(backend().router);

		const result = await generate(api, { waitForCompletion: false, maxWait: "={{ 'soon' }}" });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
	});
});

describe.concurrent('The AI tool variant, invoked in process', () => {
	const TOOL_TYPE = '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocsTool';
	/** The rows come from the agent's argument `client`, through `$fromAI`, as they do in a real tool. */
	const toolNode = (parameters: INodeParameters = {}, extra: Partial<TestNode> = {}): TestNode => ({
		...s2d(
			{
				rowsFrom: 'workflow',
				unknownKeys: 'refuse',
				dataSets: { values: [{ dataSetId: DS_ID, rows: `={{ JSON.stringify([{ 'Client name': $fromAI('client') }]) }}` }] },
				...parameters,
			},
			{ ...extra, id: 'node-1' },
		),
		type: TOOL_TYPE,
	});
	const retryingTool = { retryOnFail: true, maxTries: 2, waitBetweenTries: 0 };

	it('one run, one key on both POSTs, when the first poll answers 401 and Retry On Fail tries again', async () => {
		const fake = backend({
			status: 'processing',
			getRun: (n) => (n === 1 ? failure(401, 'auth', 'Invalid API token.') : succeededRun()),
		});
		const api = await startApi(fake.router);

		const { outcomes } = await runAsTool({
			baseUrl: api.baseUrl,
			node: toolNode({ waitForCompletion: true, maxWait: 30, pollEvery: 2 }, retryingTool),
			calls: [{ client: 'A1' }],
		});

		expect(outcomes).toEqual([{ response: expect.stringContaining('"succeeded"') }]);
		expect(fake.state.created).toBe(1);
		expect(api.posts()).toHaveLength(2);
		expect(new Set(api.posts().map(keyOf)).size).toBe(1);
		expect(keyOf(api.posts()[0])).toMatch(/^n8n:[0-9a-f]{16}:engine-test:1:node-1:[0-9a-f]{32,}$/);
		expect(outcomes[0]).toHaveProperty('response', expect.stringContaining('"idempotent_replay":true'));
	});

	const keysOf = (api: FakeApi) => api.posts().map(keyOf) as string[];

	it('two invocations with different input send different keys', async () => {
		const fake = backend({ status: 'succeeded' });
		const api = await startApi(fake.router);

		await runAsTool({ baseUrl: api.baseUrl, node: toolNode(), calls: [{ client: 'A1' }, { client: 'B1' }] });

		const [first, second] = keysOf(api);
		expect(first).not.toBe(second);
		expect(fake.state.created).toBe(2);
	});

	it('two invocations with identical input send the same key: one run, and the second is marked idempotent_replay', async () => {
		const fake = backend({ status: 'succeeded' });
		const api = await startApi(fake.router);

		const { outcomes } = await runAsTool({ baseUrl: api.baseUrl, node: toolNode(), calls: [{ client: 'A1' }, { client: 'A1' }] });

		const [first, second] = keysOf(api);
		expect(first).toBe(second);
		expect(fake.state.created).toBe(1);
		expect(outcomes[0]).not.toHaveProperty('response', expect.stringContaining('idempotent_replay'));
		expect(outcomes[1]).toHaveProperty('response', expect.stringContaining('"idempotent_replay":true'));
	});
});

describe.concurrent('An automatic key adopts only a recent run', () => {
	const HOURS = 3600 * 1000;
	const ago = (hours: number) => new Date(Date.now() - hours * HOURS).toISOString();

	/** Two runs of the node under one key (same execution id); the run the first start created has `createdAt`. */
	async function twice(parameters: INodeParameters, createdAt: string, extra: Partial<BackendOptions> = {}) {
		const fake = backend({ createdAt: (n) => (n === 1 ? createdAt : ago(0)), ...extra });
		const api = await startApi(fake.router);
		await generate(api, parameters);
		const result = await generate(api, parameters);
		return { fake, api, result };
	}

	it('a run created 7 h ago under the automatic key is not adopted: a new run starts under <key>:after:<id>', async () => {
		const { fake, api, result } = await twice({}, ago(7));

		const first = keyOf(api.posts()[0]) as string;
		expect(api.posts().map(keyOf)).toEqual([first, first, `${first}:after:${RUN_1}`]);
		expect(fake.state.created).toBe(2);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: runId(2) })]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('idempotent_replay');
	});

	it('a run created 1 h ago is adopted', async () => {
		const { fake, result } = await twice({}, ago(1));

		expect(fake.state.created).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
	});

	it('a run created 7 h ago under a key the person set is adopted, whatever its age', async () => {
		const { fake, result } = await twice({ idempotencyKey: 'monthly' }, ago(7));

		expect(fake.state.created).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
	});

	it('a created_at that does not parse is adopted', async () => {
		const { fake, result } = await twice({}, 'not a date');

		expect(fake.state.created).toBe(1);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ run_id: RUN_1, idempotent_replay: true })]);
	});
});

describe.concurrent('The key chain is bounded', () => {
	it('a server that answers every start with a conflict naming a fresh failed run gets at most 11 POSTs, and the last run is returned', async () => {
		let posts = 0;
		const api = await startApi((request) => {
			if (request.method === 'POST') {
				posts += 1;
				return failure(422, 'generic', 'A run with this idempotency key already exists.', {
					code: 'run_idempotency_conflict',
					run_id: `c0000000-0000-4000-8000-${String(posts).padStart(12, '0')}`,
				});
			}
			if (request.path.startsWith(`${API_PATH}/runs/`)) {
				return ok({ run: runPayload({ id: request.path.split('/').pop(), status: 'failed', error_message: 'boom' }) });
			}
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await generate(api, {});

		// MAX_KEY_CHAIN is 10 chain steps: the first POST plus ten derived keys.
		expect(api.posts()).toHaveLength(11);
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ run_id: 'c0000000-0000-4000-8000-000000000011', status: 'failed', idempotent_replay: true }),
		]);
	});
});
