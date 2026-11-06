/**
 * The optional fields of Document → Generate and Run → Get live in the Options collection. These
 * cases pin the node version each time (the harness defaults to 1) and read what the node did on
 * the wire, so a value that n8n dropped on the way would show as the default behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { INodeParameters } from 'n8n-workflow';

import {
	API_PATH,
	bodyOf,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	useFakeApis,
	type FakeApi,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis({ concurrent: true });

const BATCH_ID = 'c0000000-0000-4000-8000-000000000001';
const DIST = 'd0000000-0000-4000-8000-000000000001';

/** Generate with exactly the Options given: unlike `s2d`, no "don't wait" default is added. */
const generateNode = (typeVersion: number, options: INodeParameters): TestNode => {
	const base = s2dConnected({}, { typeVersion });
	return { ...base, parameters: { ...base.parameters, options } };
};

async function through(api: FakeApi, node: TestNode) {
	return await runWorkflow({ baseUrl: api.baseUrl, nodes: [emit([{ json: {} }]), node], connections: [['Emit', 'SourceToDocs']] });
}

const startRouter =
	(status: string, onPoll: () => ReturnType<Router> = () => ok({ run: runPayload({ status: 'succeeded' }) })): Router =>
	(request) =>
		request.method === 'POST' ? ok({ run: runPayload({ status }) }, 201) : onPoll();

describe.concurrent('Generate, with Options left empty (the version a new node gets)', () => {
	it('waits with the 300 s / 5 s defaults, sends the automatic key and no distribution_ids', async () => {
		const api = await startApi(startRouter('pending'));

		const result = await through(api, generateNode(1.1, {}));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.gets()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		// One poll, after the default Poll Every of 5 s.
		expect(result.ms).toBeGreaterThanOrEqual(4900);
		expect((api.posts()[0].body as { idempotency_key: string }).idempotency_key).toMatch(/^n8n:/);
		expect(api.posts()[0].body).not.toHaveProperty('distribution_ids');
	});
});

describe('Generate, with Options left empty, a run that takes two polls', () => {
	it('ends succeeded, not timed out, after about 10 s: the default Max Wait is well above one poll', async () => {
		let polls = 0;
		const api = await startApi(
			startRouter('pending', () => ok({ run: runPayload({ status: ++polls < 2 ? 'processing' : 'succeeded' }) })),
		);

		const result = await through(api, generateNode(1.1, {}));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.gets()).toHaveLength(2);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('timed_out');
		expect(result.ms).toBeGreaterThanOrEqual(9900);
	}, 30_000);
});

describe.concurrent.each([1, 1.1])('Generate, each option set, node version %s', (version) => {
	it('Deliver to is sent as distribution_ids', async () => {
		const api = await startApi(startRouter('succeeded'));

		await through(api, generateNode(version, { waitForCompletion: false, distributionIds: [DIST] }));

		expect(bodyOf(api.posts()[0])).toEqual({ distribution_ids: [DIST] });
	});

	it('Wait for Completion off returns the started run without polling', async () => {
		const api = await startApi(startRouter('pending'));

		const result = await through(api, generateNode(version, { waitForCompletion: false }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.gets()).toHaveLength(0);
		expect(result.json('SourceToDocs')).toEqual([expect.objectContaining({ status: 'pending' })]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('timed_out');
	});

	it('Max Wait and Poll Every reach the poll loop', async () => {
		const api = await startApi(startRouter('pending', () => ok({ run: runPayload({ status: 'processing' }) })));

		const result = await through(api, generateNode(version, { maxWait: 2, pollEvery: 2 }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.gets()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'processing', timed_out: true });
		// The 300 s / 5 s defaults would still be polling.
		expect(result.ms).toBeLessThan(4500);
	});

	it('Max Wait and Poll Every are clamped to a 2 s poll even when given 0', async () => {
		const api = await startApi(startRouter('pending'));

		const result = await through(api, generateNode(version, { maxWait: 0, pollEvery: 0 }));

		expect(api.gets()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		expect(result.ms).toBeGreaterThanOrEqual(1900);
		expect(result.ms).toBeLessThan(4500);
	});

	it('an Idempotency Key is sent as given', async () => {
		const api = await startApi(startRouter('succeeded'));

		await through(api, generateNode(version, { waitForCompletion: false, idempotencyKey: 'invoice-7' }));

		expect(api.posts()[0].body).toEqual({ idempotency_key: 'invoice-7' });
	});
});

describe.concurrent('Run → Get at node version 1.1', () => {
	const batch = runPayload({ id: BATCH_ID, kind: 'batch', status: 'succeeded', file_count: 2 });
	const children = [runPayload({ id: 'child-1', split_key: 'Acme' }), runPayload({ id: 'child-2', split_key: 'Globex' })];
	const router: Router = (request) => (request.path.endsWith('/children') ? ok({ runs: children }) : ok({ run: batch }));
	const getNode = (typeVersion: number, options: INodeParameters): TestNode => {
		const base = s2d({ resource: 'run', operation: 'get', runId: BATCH_ID }, { typeVersion });
		return { ...base, parameters: { ...base.parameters, options } };
	};

	it('lists the children when Options is empty, one item per file', async () => {
		const api = await startApi(router);

		const result = await through(api, getNode(1.1, {}));

		expect(result.json('SourceToDocs')).toHaveLength(2);
		expect(api.gets().map((request) => request.path)).toEqual([`${API_PATH}/runs/${BATCH_ID}`, `${API_PATH}/runs/${BATCH_ID}/children`]);
	});

	it.each([1, 1.1])('Summary Only on returns one summary item and reads no children, node version %s', async (version) => {
		const api = await startApi(router);

		const result = await through(api, getNode(version, { summaryOnly: true }));

		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ run_id: BATCH_ID, file_count: 2 });
		expect(api.gets().map((request) => request.path)).toEqual([`${API_PATH}/runs/${BATCH_ID}`]);
	});

	it('Max Wait bounds the read of the children: a list that keeps answering 429 ends within it', async () => {
		const api = await startApi((request) =>
			request.path.endsWith('/children') ? { ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '1' } } : ok({ run: batch }),
		);

		const result = await through(api, getNode(1.1, { maxWait: 1 }));

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		// Max Wait 1 is raised to the 5 s floor; the 300 s default would still be trying.
		expect(result.ms).toBeGreaterThanOrEqual(4000);
		expect(result.ms).toBeLessThan(15000);
	});
});
