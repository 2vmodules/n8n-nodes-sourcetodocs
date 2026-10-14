/**
 * The four reads (Project → Get Many, Document → Get Many, Document → Get, Run → Get) and the
 * node's dispatch, through n8n's own engine. Moved from the stubbed reads, node and
 * negativeCases tests, with the many-items cases the stubs could not model.
 *
 * Continue On Fail items keep the flat json shape in regular mode, and `{ error, details }` in error-output mode (error-output.engine.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	defaultRouter,
	documentPayload,
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

const startApi = useFakeApis();

async function readWith(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

const projectGetMany = (extra: Record<string, unknown> = {}, node: Record<string, unknown> = {}) =>
	s2d({ resource: 'project', operation: 'getMany', ...extra }, node);
const documentGetMany = (projectId = 'a0000000-0000-4000-8000-000000000001', node: Record<string, unknown> = {}) =>
	s2d({ resource: 'document', operation: 'getMany', projectId }, node);
const documentGet = (node: Record<string, unknown> = {}) => s2d({ resource: 'document', operation: 'get' }, node);
const runGet = (runId: string, extra: Record<string, unknown> = {}, node: Record<string, unknown> = {}) =>
	s2d({ resource: 'run', operation: 'get', runId, ...extra }, node);

const paths = (api: FakeApi) => api.requests.map((r) => `${r.method} ${r.path}`);

describe('Project → Get Many', () => {
	const projects = [
		{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Marketing', timezone: 'UTC' },
		{ id: 'a0000000-0000-4000-8000-000000000002', name: 'Sales', timezone: null },
	];

	it('returns the projects payload, one item per project', async () => {
		const api = await startApi(() => ok({ projects }));

		const result = await readWith(api, projectGetMany());

		expect(paths(api)).toEqual([`GET ${API_PATH}/projects`]);
		expect(result.json('SourceToDocs')).toEqual(projects);
		expect(result.items('SourceToDocs').map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
	});

	it('reads once per input item and pairs each answer to its own item (3 items)', async () => {
		const api = await startApi(() => ok({ projects }));

		const result = await readWith(api, projectGetMany(), [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }]);

		expect(api.requests).toHaveLength(3);
		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(6);
		expect(items.map((i) => i.pairedItem)).toEqual([0, 0, 1, 1, 2, 2].map((item) => ({ item })));
	});

	it('an empty list is zero items, and the run still succeeds', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		const result = await readWith(api, projectGetMany());

		expect(result.run.status).toBe('success');
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([]);
	});
});

describe('Document → Get Many', () => {
	it("returns the project's documents payload, one item per document, from the project's own path", async () => {
		const documents = [
			{ id: 'd-1', project_id: 'a0000000-0000-4000-8000-000000000001', name: 'Weekly report' },
			{ id: 'd-2', project_id: 'a0000000-0000-4000-8000-000000000001', name: 'Invoice' },
		];
		const api = await startApi(() => ok({ documents }));

		const result = await readWith(api, documentGetMany('a0000000-0000-4000-8000-000000000001'));

		expect(paths(api)).toEqual([`GET ${API_PATH}/projects/a0000000-0000-4000-8000-000000000001/documents`]);
		expect(result.json('SourceToDocs')).toEqual(documents);
	});

	it('reads the project each input item names (2 items, 2 projects)', async () => {
		const api = await startApi((request) => ok({ documents: [{ id: `d-of-${request.path}`, name: 'x' }] }));

		const result = await readWith(api, documentGetMany('={{ $json.project }}'), [
			{ json: { project: 'a0000000-0000-4000-8000-00000000000a' } },
			{ json: { project: 'a0000000-0000-4000-8000-00000000000b' } },
		]);

		expect(paths(api)).toEqual([`GET ${API_PATH}/projects/a0000000-0000-4000-8000-00000000000a/documents`, `GET ${API_PATH}/projects/a0000000-0000-4000-8000-00000000000b/documents`]);
		expect(result.items('SourceToDocs').map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});
});

describe('Document → Get', () => {
	it('returns the document payload as one item, unmodified', async () => {
		const api = await startApi(defaultRouter());

		const result = await readWith(api, documentGet());

		expect(paths(api)).toEqual([`GET ${API_PATH}/documents/${DOC_ID}`]);
		expect(result.json('SourceToDocs')).toEqual([documentPayload.data.document]);
		expect(result.items('SourceToDocs')[0].pairedItem).toEqual({ item: 0 });
	});

	it('a deleted or foreign document is a node error carrying the API message', async () => {
		const api = await startApi(() => failure(404, 'not_found', 'Resource not found.'));

		const result = await readWith(api, documentGet());

		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeApiError');
		expect(error?.message).toBe('Resource not found.');
		expect(error?.context).toMatchObject({ itemIndex: 0 });
	});
});

describe('Run → Get', () => {
	const runWithDoc = runPayload({
		status: 'succeeded',
		output_result: {
			document_id: 'd-1',
			document_url: 'https://docs.google.com/document/d/d-1',
			document_name: 'Weekly report',
			page_count: 2,
			source_document_id: 'src-1',
			source_name: 'Template',
		},
	});
	const runRouter =
		(runs: Record<string, unknown>, children: Record<string, unknown[]> = {}): Router =>
		(request) => {
			const match = /\/runs\/([^/]+)(\/children)?$/.exec(request.path);
			if (match === null) return failure(404, 'not_found', 'Resource not found.');
			if (match[2] !== undefined) return ok({ runs: children[match[1]] ?? [] });
			return match[1] in runs ? ok({ run: runs[match[1]] }) : failure(404, 'not_found', 'Resource not found.', { code: ['run_not_found'] });
		};

	it('flattens an ordinary run exactly as Generate does: file_url at the top level, no run object by default', async () => {
		const api = await startApi(runRouter({ 'b0000000-0000-4000-8000-000000000001': runWithDoc }));

		const result = await readWith(api, runGet('b0000000-0000-4000-8000-000000000001'));

		expect(paths(api)).toEqual([`GET ${API_PATH}/runs/b0000000-0000-4000-8000-000000000001`]);
		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			run_id: 'b0000000-0000-4000-8000-000000000001',
			status: 'succeeded',
			file_url: 'https://docs.google.com/document/d/d-1',
			file_name: 'Weekly report',
			page_count: 2,
		});
		expect(items[0].json).not.toHaveProperty('run');
		expect(items[0].pairedItem).toEqual({ item: 0 });
	});

	it('keeps the full run object when Simplify is off', async () => {
		const api = await startApi(runRouter({ 'b0000000-0000-4000-8000-000000000001': runWithDoc }));

		const result = await readWith(api, runGet('b0000000-0000-4000-8000-000000000001', { simplify: false }));

		expect(result.json('SourceToDocs')[0].run).toEqual(runWithDoc);
	});

	describe('a batch', () => {
		const batch = runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'succeeded', file_count: 2 });
		const children = [
			runPayload({ id: 'child-1', split_key: 'Acme' }),
			runPayload({ id: 'child-2', split_key: 'Globex' }),
		];

		it('lists its children, one item per child, each carrying the batch id and counters, when Summary Only is off', async () => {
			const api = await startApi(runRouter({ 'c0000000-0000-4000-8000-000000000001': batch }, { 'c0000000-0000-4000-8000-000000000001': children }));

			const result = await readWith(api, runGet('c0000000-0000-4000-8000-000000000001', { summaryOnly: false }));

			expect(paths(api)).toEqual([`GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001`, `GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001/children`]);
			const json = result.json('SourceToDocs');
			expect(json).toHaveLength(2);
			expect(json[0]).toMatchObject({ run_id: 'child-1', split_key: 'Acme', batch_run_id: 'c0000000-0000-4000-8000-000000000001', file_count: 2 });
			expect(json[1]).toMatchObject({ run_id: 'child-2', split_key: 'Globex', batch_run_id: 'c0000000-0000-4000-8000-000000000001' });
		});

		it('is one flattened item, with no children request, when Summary Only is on', async () => {
			const api = await startApi(runRouter({ 'c0000000-0000-4000-8000-000000000001': batch }, { 'c0000000-0000-4000-8000-000000000001': children }));

			const result = await readWith(api, runGet('c0000000-0000-4000-8000-000000000001', { summaryOnly: true }));

			expect(paths(api)).toEqual([`GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001`]);
			expect(result.json('SourceToDocs')).toHaveLength(1);
			expect(result.json('SourceToDocs')[0]).toMatchObject({ run_id: 'c0000000-0000-4000-8000-000000000001', status: 'succeeded', file_count: 2 });
			expect(result.json('SourceToDocs')[0]).not.toHaveProperty('run');
		});

		it('is the batch itself as the one item when it has no children', async () => {
			const empty = runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'succeeded', file_count: 0 });
			const api = await startApi(runRouter({ 'c0000000-0000-4000-8000-000000000001': empty }));

			const result = await readWith(api, runGet('c0000000-0000-4000-8000-000000000001', { summaryOnly: false }));

			expect(paths(api)).toEqual([`GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001`, `GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001/children`]);
			expect(result.json('SourceToDocs')).toHaveLength(1);
			expect(result.json('SourceToDocs')[0]).toMatchObject({ run_id: 'c0000000-0000-4000-8000-000000000001', file_count: 0 });
		});

		it('keeps every child under Simplify off, each with its own run object', async () => {
			const api = await startApi(runRouter({ 'c0000000-0000-4000-8000-000000000001': batch }, { 'c0000000-0000-4000-8000-000000000001': children }));

			const result = await readWith(api, runGet('c0000000-0000-4000-8000-000000000001', { simplify: false }));

			expect(result.json('SourceToDocs').map((j) => (j.run as { id: string }).id)).toEqual(['child-1', 'child-2']);
		});
	});

	it('returns a run whose document was deleted (the API answers 200 by the run\'s workspace)', async () => {
		const failed = runPayload({
			status: 'failed',
			document_id: 'doc-deleted',
			error_code: 'render_failed',
			error_message: 'The document was deleted before this run could render it.',
		});
		const api = await startApi(runRouter({ 'b0000000-0000-4000-8000-000000000001': failed }));

		const result = await readWith(api, runGet('b0000000-0000-4000-8000-000000000001'));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')[0]).toMatchObject({
			run_id: 'b0000000-0000-4000-8000-000000000001',
			status: 'failed',
			error_code: 'render_failed',
			error_message: 'The document was deleted before this run could render it.',
		});
	});

	it('reads the run each input item names, one request per item, answers paired in order (3 items)', async () => {
		const runs = {
			'e0000000-0000-4000-8000-00000000000a': runPayload({ id: 'e0000000-0000-4000-8000-00000000000a', status: 'succeeded' }),
			'e0000000-0000-4000-8000-00000000000b': runPayload({ id: 'e0000000-0000-4000-8000-00000000000b', status: 'failed' }),
			'e0000000-0000-4000-8000-00000000000c': runPayload({ id: 'e0000000-0000-4000-8000-00000000000c', status: 'processing' }),
		};
		const api = await startApi(runRouter(runs));

		const result = await readWith(api, runGet('={{ $json.run }}'), [
			{ json: { run: 'e0000000-0000-4000-8000-00000000000a' } },
			{ json: { run: 'e0000000-0000-4000-8000-00000000000b' } },
			{ json: { run: 'e0000000-0000-4000-8000-00000000000c' } },
		]);

		expect(paths(api)).toEqual(['e0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-00000000000c'].map((id) => `GET ${API_PATH}/runs/${id}`));
		expect(result.json('SourceToDocs').map((j) => [j.run_id, j.status])).toEqual([
			['e0000000-0000-4000-8000-00000000000a', 'succeeded'],
			['e0000000-0000-4000-8000-00000000000b', 'failed'],
			['e0000000-0000-4000-8000-00000000000c', 'processing'],
		]);
		expect(result.items('SourceToDocs').map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	describe('when an item fails', () => {
		const runs = { 'e0000000-0000-4000-8000-0000000000f0': runPayload({ id: 'e0000000-0000-4000-8000-0000000000f0', status: 'succeeded' }) };
		const twoItems = [{ json: { run: 'e0000000-0000-4000-8000-0000000000f0' } }, { json: { run: 'e0000000-0000-4000-8000-0000000000f1' } }];

		it('stops the node at the failing item without Continue On Fail, naming the item index', async () => {
			const api = await startApi(runRouter(runs));

			const result = await readWith(api, runGet('={{ $json.run }}'), [{ json: { run: 'e0000000-0000-4000-8000-0000000000f1' } }, { json: { run: 'e0000000-0000-4000-8000-0000000000f0' } }]);

			expect(result.errorOf('SourceToDocs')?.name).toBe('NodeApiError');
			expect(result.errorOf('SourceToDocs')?.message).toBe('Resource not found.');
			expect(api.requests).toHaveLength(1);
			expect(result.items('SourceToDocs')).toHaveLength(0);
		});

		it('Continue On Fail yields one error item per failing item and keeps the good ones, in order, each paired to its own item', async () => {
			const api = await startApi(runRouter(runs));

			const result = await readWith(api, runGet('={{ $json.run }}', {}, { onError: 'continueRegularOutput' }), twoItems);

			expect(result.run.status).toBe('success');
			const items = result.items('SourceToDocs');
			expect(items).toHaveLength(2);
			expect(items[0].json).toMatchObject({ run_id: 'e0000000-0000-4000-8000-0000000000f0', status: 'succeeded' });
			expect(items[1].json).toEqual({
				error: 'Resource not found.',
				error_code: 'run_not_found',
				category: 'not_found',
				errors: { code: ['run_not_found'] },
			});
			expect(items.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		});

		it('Continue On Fail on a 404 without a code carries only the message and category', async () => {
			const api = await startApi(() => failure(404, 'not_found', 'Not found.'));

			const result = await readWith(api, runGet('b0000000-0000-4000-8000-000000000001', {}, { onError: 'continueRegularOutput' }));

			expect(result.json('SourceToDocs')).toEqual([{ error: 'Not found.', category: 'not_found', errors: [] }]);
		});
	});
});

describe('the dispatch', () => {
	it('an unsupported resource and operation pair is a node error before any request', async () => {
		const api = await startApi(defaultRouter());

		const result = await readWith(api, s2d({ resource: 'project', operation: 'delete' }));

		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeOperationError');
		expect(error?.message).toBe("The operation 'delete' on 'project' is not supported");
		expect(api.requests).toHaveLength(0);
	});

	it('Document → Generate sends one request however many items, while a read sends one per item', async () => {
		const api = await startApi(defaultRouter());
		const items = [{ json: {} }, { json: {} }];

		await readWith(api, s2dConnected(), items);
		const posts = api.posts().length;
		await readWith(api, documentGet(), items);

		expect(posts).toBe(1);
		expect(api.gets()).toHaveLength(2);
	});
});

describe('a read that throws something that is not a node error', () => {
	// Emit (2 items) -> Generate (one item, paired to both) -> read whose Run ID expression names
	// `$('Emit').item`: the second node's item has two matches, so n8n's expression engine throws.
	const chain = (api: FakeApi, node: TestNode) =>
		runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: { id: 'a' } }, { json: { id: 'b' } }]), s2dConnected({}, {}), { ...node, name: 'Reader' }],
			connections: [
				['Emit', 'SourceToDocs'],
				['SourceToDocs', 'Reader'],
			],
		});
	const reader = (extra: Record<string, unknown> = {}) =>
		s2d({ resource: 'run', operation: 'get', runId: `={{ $('Emit').item.json.id }}` }, extra);

	it('is wrapped into a NodeOperationError that keeps the expression message, with the item index', async () => {
		const api = await startApi(defaultRouter());

		const result = await chain(api, reader());

		const error = result.errorOf('Reader');
		expect(error?.name).toBe('NodeOperationError');
		expect(error?.message).toMatch(/Multiple matches found/);
		expect(error?.context).toMatchObject({ itemIndex: 0 });
	});

	it('with Continue On Fail becomes an error item paired to its own item', async () => {
		const api = await startApi(defaultRouter());

		const result = await chain(api, reader({ onError: 'continueRegularOutput' }));

		const items = result.items('Reader');
		expect(items).toHaveLength(1);
		expect(String(items[0].json.error)).toMatch(/Multiple matches found/);
		expect(items[0].pairedItem).toEqual({ item: 0 });
	});
});
