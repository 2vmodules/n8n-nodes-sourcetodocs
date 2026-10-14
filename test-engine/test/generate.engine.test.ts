/**
 * Document → Generate through n8n's own engine: what request the API receives and what output
 * items n8n holds afterwards. Moved from the stubbed generateDocument tests; every run here is
 * terminal from its 201, so nothing waits (the real-time cases are in generate-waiting).
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	DS2_ID,
	DS_ID,
	defaultRouter,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2dConnected,
	s2dJson,
	bodyOf,
	useFakeApis,
	type FakeApi,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

async function generate(
	api: FakeApi,
	node: TestNode,
	items: unknown[] = [{ json: { n: 1 } }],
) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

const rows = (value: unknown) => JSON.stringify(value);

/** What the engine keeps of a thrown node error: a plain copy with `name`, `description` and `context`. */
interface NodeErrorCopy {
	name: string;
	message: string;
	description?: string;
	context: Record<string, unknown>;
}

describe('Generate sends one request per execution', () => {
	it('sends exactly one POST however many items are on the input (40)', async () => {
		const api = await startApi();
		const items = Array.from({ length: 40 }, (_, i) => ({ json: { i } }));

		const result = await generate(api, s2dConnected(), items);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests).toHaveLength(1);
		expect(api.requests[0]).toMatchObject({ method: 'POST', path: `${API_PATH}/documents/${DOC_ID}/runs` });
		expect(result.items('SourceToDocs')).toHaveLength(1);
	});

	it('sends no inline_data when rows come from the connected sources', async () => {
		const api = await startApi();

		await generate(api, s2dConnected());

		// No inline_data, no distribution_ids, no key: the POST carries no body at all.
		expect(bodyOf(api.posts()[0])).toBeUndefined();
	});

	it('keys inline_data by Data Set id, one entry per Data Sets row: two entries, two keys', async () => {
		const api = await startApi();
		const node = s2dJson(
			[
				{ dataSetId: DS_ID, rows: rows([{ Name: 'Acme' }, { Name: 'Globex' }]) },
				{ dataSetId: DS2_ID, rows: rows([{ Line: 1 }]) },
			],
			{ unknownKeys: 'refuse' },
		);

		await generate(api, node);

		expect(bodyOf(api.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ Name: 'Acme' }, { Name: 'Globex' }], [DS2_ID]: [{ Line: 1 }] },
		});
	});

	it('sends rows an expression resolved to an array, from the input items', async () => {
		const api = await startApi();
		const node = s2dJson([{ dataSetId: DS_ID, rows: '={{ $input.all().map(i => i.json) }}' }], {
			unknownKeys: 'refuse',
		});

		await generate(api, node, [{ json: { Name: 'A' } }, { json: { Name: 'B' } }, { json: { Name: 'C' } }]);

		expect(bodyOf(api.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }] },
		});
	});

	it('sends distribution_ids only when at least one is picked', async () => {
		const withOne = await startApi();
		await generate(withOne, s2dConnected({ distributionIds: ['d0000000-0000-4000-8000-000000000001'] }));
		expect(bodyOf(withOne.posts()[0])).toEqual({ distribution_ids: ['d0000000-0000-4000-8000-000000000001'] });

		const withNone = await startApi();
		await generate(withNone, s2dConnected({ distributionIds: [] }));
		expect(bodyOf(withNone.posts()[0])).toBeUndefined();
	});

	it('sends a key the person set trimmed and unchanged, and its own key when it is blank', async () => {
		const api = await startApi();
		await generate(api, s2dConnected({ idempotencyKey: '  retry-1  ' }));
		expect(api.posts()[0].body).toEqual({ idempotency_key: 'retry-1' });

		const blank = await startApi();
		await generate(blank, s2dConnected({ idempotencyKey: '   ' }));
		expect(bodyOf(blank.posts()[0])).toBeUndefined();
		expect((blank.posts()[0].body as { idempotency_key: string }).idempotency_key).toMatch(/^n8n:/);
	});

	it('refuses, before any request, a Rows value that is not an array of objects', async () => {
		const api = await startApi();

		const result = await generate(api, s2dJson([{ dataSetId: DS_ID, rows: '{"not":"an array"}' }]));

		// The engine stores a plain copy of the thrown error, so the class shows as its name.
		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeOperationError');
		expect(error?.message).toMatch(/'Rows' of entry 1 in 'Data Sets' must be a JSON array of objects/);
		expect(api.requests).toHaveLength(0);
	});
});

describe('Generate with waiting off', () => {
	it('returns the 201 body flattened, without polling', async () => {
		const api = await startApi(defaultRouter({ status: 'pending' }));

		const result = await generate(api, s2dConnected());

		expect(api.requests).toHaveLength(1);
		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ run_id: 'b0000000-0000-4000-8000-000000000001', status: 'pending', file_url: null });
	});

	it('does not add dropped_keys when rows come from the connected sources', async () => {
		const api = await startApi();

		const result = await generate(api, s2dConnected());

		expect(api.requests).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('dropped_keys');
	});
});

describe('Generate waiting on, for a run that is already terminal at the 201', () => {
	const waiting = { waitForCompletion: true, maxWait: 300, pollEvery: 5 };

	it('an ordinary run that succeeded is one item with file_url at the top level', async () => {
		const api = await startApi(
			defaultRouter({
				status: 'succeeded',
				output_result: {
					document_id: 'd-1',
					document_url: 'https://docs.google.com/document/d/d-1',
					document_name: 'Invoice',
					page_count: 3,
					source_document_id: 'src-1',
					source_name: 'Template',
				},
			}),
		);

		const result = await generate(api, s2dConnected(waiting));

		expect(api.requests.map((r) => r.method)).toEqual(['POST']);
		const items = result.json('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			status: 'succeeded',
			file_url: 'https://docs.google.com/document/d/d-1',
			file_name: 'Invoice',
			page_count: 3,
		});
	});

	it('a finished batch of 40 children is 40 items, each carrying its split_key', async () => {
		const children = Array.from({ length: 40 }, (_, i) => runPayload({ id: `child-${i}`, split_key: `Customer ${i}`, status: 'succeeded' }));
		const router: Router = (request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'succeeded', file_count: 40 }) }, 201)
				: ok({ runs: children });
		const api = await startApi(router);

		const result = await generate(api, s2dConnected(waiting));

		expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST ${API_PATH}/documents/${DOC_ID}/runs`,
			`GET ${API_PATH}/runs/c0000000-0000-4000-8000-000000000001/children`,
		]);
		const items = result.json('SourceToDocs');
		expect(items).toHaveLength(40);
		expect(items[0]).toMatchObject({ run_id: 'child-0', split_key: 'Customer 0', batch_run_id: 'c0000000-0000-4000-8000-000000000001', file_count: 40 });
		expect(items[39]).toMatchObject({ run_id: 'child-39', split_key: 'Customer 39' });
	});

	it('a batch with no children is one item, the batch itself flattened', async () => {
		const router: Router = (request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'succeeded', file_count: 0 }) }, 201)
				: ok({ runs: [] });
		const api = await startApi(router);

		const result = await generate(api, s2dConnected(waiting));

		const items = result.json('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ run_id: 'c0000000-0000-4000-8000-000000000001', file_count: 0 });
	});

	it.each(['partial_success', 'cancelled'])('a %s run is returned as an item, not thrown', async (status) => {
		const api = await startApi(defaultRouter({ status }));

		const result = await generate(api, s2dConnected(waiting));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status });
	});

	it('a failed run throws a node error naming its error_code, message and run id', async () => {
		const api = await startApi(
			defaultRouter({ status: 'failed', error_code: 'render_failed', error_message: 'The template could not be rendered.' }),
		);

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toBe('The template could not be rendered.');
		// The run's id rides along, in context and in the description, so Retry On Fail never
		// reads this as "no run was ever started".
		expect(error.description).toBe('Code: render_failed. See https://app.sourcetodocs.com/docs/guides/troubleshooting/#render_failed for what this code means and how to fix it, then run the document again. Run ID: b0000000-0000-4000-8000-000000000001');
		expect(error.context.runId).toBe('b0000000-0000-4000-8000-000000000001');
		expect(error.context.errorCode).toBe('render_failed');
		expect(result.out.SourceToDocs?.[0]?.[0] ?? []).toHaveLength(0);
	});

	it('a failed batch lists its children, naming the batch id and the failed ones', async () => {
		const children = [
			runPayload({ id: 'child-1', status: 'failed', error_code: 'render_failed' }),
			runPayload({ id: 'child-2', status: 'failed', error_code: 'render_failed' }),
			runPayload({ id: 'child-3', status: 'succeeded' }),
		];
		const router: Router = (request) =>
			request.method === 'POST' ? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed' }) }, 201) : ok({ runs: children });
		const api = await startApi(router);

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		const description = error.description ?? '';
		expect(description).toContain('c0000000-0000-4000-8000-000000000001');
		expect(description).toContain('child-1 (render_failed)');
		expect(description).toContain('child-2 (render_failed)');
		expect(description).not.toContain('child-3');
		expect(error.context.runId).toBe('c0000000-0000-4000-8000-000000000001');
		expect(error.context.failedChildren).toHaveLength(2);
	});

	it('names only the first three failed children, then a count, for a larger failed batch', async () => {
		const children = Array.from({ length: 5 }, (_, i) => runPayload({ id: `child-${i}`, status: 'failed', error_code: 'render_failed' }));
		const router: Router = (request) =>
			request.method === 'POST' ? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed' }) }, 201) : ok({ runs: children });
		const api = await startApi(router);

		const result = await generate(api, s2dConnected(waiting));

		const description = (result.errorOf('SourceToDocs') as unknown as NodeErrorCopy).description ?? '';
		expect(description).toContain(', and 2 more');
		for (const named of ['child-0', 'child-1', 'child-2']) expect(description).toContain(named);
		for (const left of ['child-3', 'child-4']) expect(description).not.toContain(left);
	});
});

describe('Generate, Unknown Fields', () => {
	it('Drop (the default) removes fields that are not the Data Set columns, and reports them', async () => {
		const api = await startApi();
		const node = s2dJson([
			{ dataSetId: DS_ID, rows: rows([{ 'Client name': 'Acme', id: 'rec1', createdTime: '2026-01-01' }]) },
		]);

		const result = await generate(api, node);

		expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`GET ${API_PATH}/documents/${DOC_ID}`,
			`POST ${API_PATH}/documents/${DOC_ID}/runs`,
		]);
		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ 'Client name': 'Acme' }] } });
		const dropped = result.json('SourceToDocs')[0].dropped_keys as Record<string, string[]>;
		expect([...dropped[DS_ID]].sort()).toEqual(['createdTime', 'id']);
	});

	it('reports no dropped keys (an empty object) when every field is already a column', async () => {
		const api = await startApi();
		const node = s2dJson([{ dataSetId: DS_ID, rows: rows([{ 'Client name': 'Acme' }]) }]);

		const result = await generate(api, node);

		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ 'Client name': 'Acme' }] } });
		expect(result.json('SourceToDocs')[0].dropped_keys).toEqual({});
	});

	it('Refuse sends rows exactly as given and never reads the document', async () => {
		const api = await startApi();
		const node = s2dJson([{ dataSetId: DS_ID, rows: rows([{ id: 'rec1', 'Client name': 'Acme' }]) }], {
			unknownKeys: 'refuse',
		});

		const result = await generate(api, node);

		expect(api.requests).toHaveLength(1);
		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ id: 'rec1', 'Client name': 'Acme' }] } });
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('dropped_keys');
	});

	it('leaves rows untouched for a Data Set the document does not know, so the API refuses it', async () => {
		const unknown = '99999999-9999-4999-8999-999999999999';
		const defaults = defaultRouter();
		const api = await startApi((request, all) =>
			request.method === 'POST'
				? failure(422, 'validation', 'Unknown data set.', { code: ['inline_data_set_unknown'], data_set_id: [unknown] })
				: defaults(request, all),
		);
		const node = s2dJson([{ dataSetId: unknown, rows: rows([{ id: 'rec1' }]) }]);

		const result = await generate(api, node);

		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [unknown]: [{ id: 'rec1' }] } });
		expect(result.errorOf('SourceToDocs')?.name).toBe('NodeApiError');
	});
});

describe('Generate, pairing and Simplify', () => {
	it('pairs the single-run item to every input item, not just item 0', async () => {
		const api = await startApi();

		const result = await generate(api, s2dConnected(), [{ json: { i: 0 } }, { json: { i: 1 } }, { json: { i: 2 } }]);

		expect(result.items('SourceToDocs')[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	it('pairs every batch child to every input item too', async () => {
		const children = [runPayload({ id: 'child-1' }), runPayload({ id: 'child-2' })];
		const router: Router = (request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'succeeded', file_count: 2 }) }, 201)
				: ok({ runs: children });
		const api = await startApi(router);

		const result = await generate(
			api,
			s2dConnected({ waitForCompletion: true, maxWait: 300, pollEvery: 5 }),
			[{ json: { i: 0 } }, { json: { i: 1 } }, { json: { i: 2 } }],
		);

		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(2);
		expect(items[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
		expect(items[1].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	it('omits the run object by default (Simplify on)', async () => {
		const api = await startApi();

		const result = await generate(api, s2dConnected());

		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('run');
	});

	it('keeps the full run object when Simplify is off', async () => {
		const api = await startApi(defaultRouter({ status: 'succeeded' }));

		const result = await generate(api, s2dConnected({ simplify: false }));

		expect(result.json('SourceToDocs')[0].run).toEqual(runPayload({ status: 'succeeded' }));
	});
});
