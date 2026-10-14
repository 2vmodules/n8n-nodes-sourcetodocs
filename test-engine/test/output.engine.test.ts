/**
 * Node version 1.1: the run fields, the Output option, and Get Many's Return All and Limit,
 * through n8n's own engine. Version 1 is loaded beside it and must stay exactly as it was: its
 * parameters and its output.
 */
import { describe, expect, it } from 'vitest';
import type { INodeParameters } from 'n8n-workflow';

import {
	API_PATH,
	emit,
	documentRouter,
	failure,
	ok,
	otherShown,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	s2dDescription,
	s2dMapped,
	splitOn,
	useFakeApis,
	wf,
	type FakeApi,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

const V11 = { typeVersion: 1.1 };
const RUN_ID = 'b0000000-0000-4000-8000-000000000001';
const BATCH_ID = 'c0000000-0000-4000-8000-000000000001';
const FOLDER = 'https://drive.google.com/drive/folders/F1';

const file = { document_id: 'd-1', document_url: 'https://docs.google.com/document/d/d-1', document_name: 'Report', page_count: 2, source_document_id: 's-1', source_name: 'Tpl' };

/** A finished single run that has something to say in every new field. */
const talkative = runPayload({
	status: 'partial_success',
	output_result: file,
	warnings: [{ code: 'missing_image', message: 'Image not found', where: 'slide 2' }],
	processing_started_at: '2026-01-01T00:00:01Z',
	finished_at: '2026-01-01T00:00:09Z',
	distributions: [
		{
			id: 'rd-1', run_id: RUN_ID, distribution_id: 'dist-1', distribution_type: 'google_drive', status: 'succeeded', result: { id: 'x' },
			error_code: null, error_message: null, attempted_at: null, finished_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
		},
	],
});

/** Everything a v1 item has, in today's key order. */
const V1_KEYS = ['run_id', 'status', 'kind', 'split_key', 'file_url', 'file_name', 'page_count', 'file_count', 'progress', 'deliveries', 'error_code', 'error_message'];
const NEW_KEYS = ['warnings', 'generation_stats', 'folder_url', 'document_id', 'processing_started_at', 'finished_at'];

const routerFor = (run: Record<string, unknown>, children: Record<string, unknown>[] = []): Router => (request) => {
	if (request.method === 'POST') return ok({ run: runPayload(run) }, 201);
	if (request.path.endsWith('/children')) return ok({ runs: children });
	if (request.path.startsWith(`${API_PATH}/runs/`)) return ok({ run: runPayload(run) });
	return failure(404, 'not_found', 'Resource not found.');
};

async function through(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({ baseUrl: api.baseUrl, nodes: [emit(items), node], connections: [['Emit', node.name]] });
}

const runGet = (extra: INodeParameters = {}, node: Partial<TestNode> = {}): TestNode =>
	({ ...s2d({ resource: 'run', operation: 'get', runId: RUN_ID, ...extra }), ...node }) as TestNode;

/** The parameters n8n keeps for a node of `typeVersion`, defaults filled and hidden ones left out. */
function storedParameters(typeVersion: number, parameters: INodeParameters): INodeParameters {
	const node = { id: '1', name: 'n', type: 't', typeVersion, position: [0, 0] as [number, number], parameters };
	return wf.NodeHelpers.getNodeParameters(s2dDescription.properties, parameters, true, false, node, s2dDescription) as INodeParameters;
}

const doc = { __rl: true, mode: 'id', value: 'x' };

describe('version 1 keeps its parameters', () => {
	// These exact objects are what version 1 has always held.
	it.each([
		[
			'Generate',
			{ resource: 'document', operation: 'generate', documentId: doc, waitForCompletion: false, rowsFrom: 'connected' },
			{ resource: 'document', operation: 'generate', projectId: '', documentId: doc, rowsFrom: 'connected', distributionIds: [], waitForCompletion: false, idempotencyKey: '', simplify: true },
		],
		[
			'Generate, waiting',
			{ resource: 'document', operation: 'generate', documentId: doc, waitForCompletion: true, rowsFrom: 'connected' },
			{ resource: 'document', operation: 'generate', projectId: '', documentId: doc, rowsFrom: 'connected', distributionIds: [], waitForCompletion: true, maxWait: 300, pollEvery: 5, idempotencyKey: '', simplify: true },
		],
		['Run → Get', { resource: 'run', operation: 'get', runId: 'r' }, { resource: 'run', operation: 'get', runId: 'r', summaryOnly: false, simplify: true }],
		['Project → Get Many', { resource: 'project', operation: 'getMany' }, { resource: 'project', operation: 'getMany' }],
		['Document → Get Many', { resource: 'document', operation: 'getMany', projectId: 'p' }, { resource: 'document', operation: 'getMany', projectId: 'p' }],
		[
			'Document → Get',
			{ resource: 'document', operation: 'get', documentId: doc },
			{ resource: 'document', operation: 'get', projectId: '', documentId: doc },
		],
	])('%s: the stored parameters are today\'s, with no output, limit or returnAll', (_name, stored, expected) => {
		expect(storedParameters(1, stored as INodeParameters)).toEqual(expected);
	});

	it('version 1.1 swaps Simplify for Output, adds Return All and Run → Get\'s Max Wait, nothing else', () => {
		expect(storedParameters(1.1, { resource: 'run', operation: 'get', runId: 'r' })).toEqual({
			resource: 'run', operation: 'get', runId: 'r', summaryOnly: false, maxWait: 300, output: 'simplified',
		});
		expect(storedParameters(1.1, { resource: 'document', operation: 'generate', documentId: doc, waitForCompletion: false, rowsFrom: 'connected' })).toEqual({
			resource: 'document', operation: 'generate', projectId: '', documentId: doc, rowsFrom: 'connected', distributionIds: [], waitForCompletion: false, idempotencyKey: '', output: 'simplified',
		});
		expect(storedParameters(1.1, { resource: 'project', operation: 'getMany' })).toEqual({ resource: 'project', operation: 'getMany', returnAll: true });
		expect(storedParameters(1.1, { resource: 'document', operation: 'getMany', projectId: 'p', returnAll: false })).toEqual({
			resource: 'document', operation: 'getMany', projectId: 'p', returnAll: false, limit: 50,
		});
		expect(storedParameters(1.1, { resource: 'run', operation: 'get', runId: 'r', output: 'selected' })).toMatchObject({ output: 'selected', outputFields: ['run_id', 'status', 'file_url'] });
	});

	it('the node is versioned [1, 1.1] and new nodes get 1.1', () => {
		expect(s2dDescription.version).toEqual([1, 1.1]);
		expect(s2dDescription.defaultVersion).toBe(1.1);
	});
});

describe('a v1 node and a v1.1 node side by side', () => {
	it('v1 returns today\'s item, key for key; v1.1 adds the run fields', async () => {
		const api = await startApi(routerFor({ status: 'succeeded', output_result: file }));

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), runGet({}, { name: 'Old' }), runGet({}, { name: 'New', ...V11 })],
			connections: [['Emit', 'Old'], ['Emit', 'New']],
		});

		expect(Object.keys(result.json('Old')[0])).toEqual(V1_KEYS);
		expect(Object.keys(result.json('New')[0])).toEqual([...V1_KEYS, ...NEW_KEYS]);
	});

	it('v1 Generate keeps its item too, and Simplify off still adds only run', async () => {
		const api = await startApi(routerFor({ status: 'succeeded', output_result: file, warnings: [{ code: 'w', message: 'm' }] }));

		const simple = await through(api, s2dConnected());
		const raw = await through(api, s2dConnected({ simplify: false }));

		expect(Object.keys(simple.json('SourceToDocs')[0])).toEqual(V1_KEYS);
		expect(Object.keys(raw.json('SourceToDocs')[0])).toEqual([...V1_KEYS, 'run']);
		expect(simple.json('SourceToDocs')[0].deliveries).toEqual([]);
	});

	it('v1 delivery items have no distribution_id; v1.1 has it', async () => {
		const api = await startApi(routerFor(talkative as Record<string, unknown>));

		const old = await through(api, s2dConnected());
		const next = await through(api, s2dConnected({}, V11));

		expect(Object.keys((old.json('SourceToDocs')[0].deliveries as object[])[0])).toEqual(['id', 'type', 'status', 'result', 'error_code', 'error_message']);
		expect((next.json('SourceToDocs')[0].deliveries as Array<Record<string, unknown>>)[0].distribution_id).toBe('dist-1');
	});

	it('v1 ignores an Output parameter a workflow might carry: Simplify decides', async () => {
		const api = await startApi(routerFor({ status: 'succeeded', output_result: file }));

		const result = await through(api, s2dConnected({ output: 'selected', outputFields: ['run_id'], simplify: false }));

		expect(Object.keys(result.json('SourceToDocs')[0])).toEqual([...V1_KEYS, 'run']);
	});
});

describe('version 1.1 run fields', () => {
	it('a single run carries warnings, generation_stats, folder_url, document_id and the timestamps', async () => {
		const api = await startApi(routerFor(talkative as Record<string, unknown>));

		const result = await through(api, s2dConnected({}, V11));

		expect(result.json('SourceToDocs')[0]).toMatchObject({
			warnings: [{ code: 'missing_image', message: 'Image not found', where: 'slide 2' }],
			generation_stats: null,
			folder_url: null,
			document_id: talkative.document_id,
			processing_started_at: '2026-01-01T00:00:01Z',
			finished_at: '2026-01-01T00:00:09Z',
			status: 'partial_success',
		});
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('run');
	});

	it('a run the API sent with none of them gets [] and null, not missing keys', async () => {
		const bare = { ...runPayload({ status: 'succeeded' }) } as Record<string, unknown>;
		for (const key of ['warnings', 'generation_stats', 'destinations']) delete bare[key];
		const api = await startApi(routerFor(bare));

		const item = (await through(api, s2dConnected({}, V11))).json('SourceToDocs')[0];

		expect(item).toMatchObject({ warnings: [], generation_stats: null, folder_url: null, processing_started_at: null, finished_at: null });
	});

	describe('a batch', () => {
		const batch = {
			id: BATCH_ID, kind: 'batch', status: 'succeeded', file_count: 2,
			generation_stats: { skipped_null: 3, orphan: 1, over_limit: 0 },
			destinations: [
				{ distribution_id: 'dist-d', distribution_type: 'download', external_id: 'z', url: null },
				{ distribution_id: 'dist-1', distribution_type: 'google_drive', external_id: 'F1', url: FOLDER },
			],
		};
		const children = [runPayload({ id: 'child-1', split_key: 'Acme' }), runPayload({ id: 'child-2', split_key: 'Globex' })];

		it('puts the batch folder URL and generation_stats on every child, from the first destination that has a link', async () => {
			const api = await startApi(routerFor(batch, children));

			const items = (await through(api, s2dConnected({ waitForCompletion: true }, V11))).json('SourceToDocs');

			expect(items).toHaveLength(2);
			for (const item of items) {
				expect(item).toMatchObject({ batch_run_id: BATCH_ID, folder_url: FOLDER, generation_stats: { skipped_null: 3, orphan: 1, over_limit: 0 } });
			}
		});

		it('an empty batch is itself the item, and generation_stats says why it has 0 files', async () => {
			const api = await startApi(routerFor({ ...batch, file_count: 0 }, []));

			const items = (await through(api, s2dConnected({ waitForCompletion: true }, V11))).json('SourceToDocs');

			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ run_id: BATCH_ID, file_count: 0, folder_url: FOLDER, generation_stats: { skipped_null: 3 } });
		});

		it('Run → Get reads the same fields', async () => {
			const api = await startApi(routerFor(batch, children));

			const items = (await through(api, runGet({ runId: BATCH_ID }, V11))).json('SourceToDocs');

			expect(items.map((i) => i.folder_url)).toEqual([FOLDER, FOLDER]);
		});

		it('a v1 batch child has neither', async () => {
			const api = await startApi(routerFor(batch, children));

			const items = (await through(api, s2dConnected({ waitForCompletion: true }))).json('SourceToDocs');

			expect(items).toHaveLength(2);
			expect(items[0]).not.toHaveProperty('folder_url');
			expect(items[0]).not.toHaveProperty('generation_stats');
		});
	});
});

describe('version 1.1 Output', () => {
	const modes = async (node: (extra: INodeParameters) => TestNode, run: Record<string, unknown>) => {
		const api = await startApi(routerFor(run));
		return {
			api,
			simplified: (await through(api, node({ output: 'simplified' }))).json('SourceToDocs')[0],
			raw: (await through(api, node({ output: 'raw' }))).json('SourceToDocs')[0],
			selected: (await through(api, node({ output: 'selected', outputFields: ['status', 'folder_url', 'warnings'] }))).json('SourceToDocs')[0],
		};
	};

	it.each([
		['Generate', (extra: INodeParameters) => s2dConnected(extra, V11)],
		['Run → Get', (extra: INodeParameters) => runGet(extra, V11)],
	])('%s: Simplified has the new fields and no run, Raw adds the full run, Selected keeps the picked fields only', async (_name, node) => {
		const { simplified, raw, selected } = await modes(node, talkative as Record<string, unknown>);

		expect(Object.keys(simplified)).toEqual(expect.arrayContaining([...V1_KEYS, ...NEW_KEYS]));
		expect(simplified).not.toHaveProperty('run');
		expect(raw.run).toEqual(talkative);
		expect(Object.keys(raw)).toEqual(expect.arrayContaining([...V1_KEYS, ...NEW_KEYS, 'run']));
		expect(Object.keys(selected)).toEqual(['status', 'folder_url', 'warnings', 'run_id']);
		expect(selected.warnings).toEqual(talkative.warnings);
	});

	it('Simplified is the default when Output is not set', async () => {
		const api = await startApi(routerFor(talkative as Record<string, unknown>));

		const item = (await through(api, s2dConnected({}, V11))).json('SourceToDocs')[0];

		expect(item).toHaveProperty('warnings');
		expect(item).not.toHaveProperty('run');
	});

	it('Selected Fields can keep the whole run', async () => {
		const api = await startApi(routerFor(talkative as Record<string, unknown>));

		const item = (await through(api, s2dConnected({ output: 'selected', outputFields: ['run'] }, V11))).json('SourceToDocs')[0];

		expect(Object.keys(item)).toEqual(['run', 'run_id']);
	});

	it('Selected Fields applies to every batch child, and always keeps run_id and batch_run_id', async () => {
		const children = [runPayload({ id: 'child-1', split_key: 'Acme' }), runPayload({ id: 'child-2', split_key: 'Globex' })];
		const api = await startApi(routerFor({ id: BATCH_ID, kind: 'batch', status: 'succeeded', file_count: 2 }, children));

		const picked = (await through(api, s2dConnected({ waitForCompletion: true, output: 'selected', outputFields: ['run_id', 'batch_run_id'] }, V11))).json('SourceToDocs');
		const unpicked = (await through(api, s2dConnected({ waitForCompletion: true, output: 'selected', outputFields: ['run_id'] }, V11))).json('SourceToDocs');

		expect(picked).toEqual([{ run_id: 'child-1', batch_run_id: BATCH_ID }, { run_id: 'child-2', batch_run_id: BATCH_ID }]);
		expect(unpicked).toEqual([{ run_id: 'child-1', batch_run_id: BATCH_ID }, { run_id: 'child-2', batch_run_id: BATCH_ID }]);
		const onlyStatus = (await through(api, s2dConnected({ waitForCompletion: true, output: 'selected', outputFields: ['status'] }, V11))).json('SourceToDocs');
		expect(onlyStatus).toEqual([{ status: 'pending', run_id: 'child-1', batch_run_id: BATCH_ID }, { status: 'pending', run_id: 'child-2', batch_run_id: BATCH_ID }]);
	});

	it('a timed-out item keeps run_id whichever fields are selected, and a single run has no batch_run_id', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : ok({ run: runPayload({ status: 'processing' }) })));

		const waited = await through(api, s2dConnected({ output: 'selected', outputFields: ['file_url'], waitForCompletion: true, maxWait: 2, pollEvery: 2 }, V11));

		const item = waited.json('SourceToDocs')[0];
		expect(item).toMatchObject({ run_id: RUN_ID, timed_out: true });
		expect(item).not.toHaveProperty('batch_run_id');
	});

	it('Selected Fields takes names from an expression, as a list or a comma-separated string', async () => {
		const api = await startApi(routerFor(talkative as Record<string, unknown>));

		const asString = await through(api, s2dConnected({ output: 'selected', outputFields: '=run_id, status' }, V11));
		const asList = await through(api, s2dConnected({ output: 'selected', outputFields: '={{ ["run_id", "status"] }}' }, V11));

		expect(asString.json('SourceToDocs')[0]).toEqual({ run_id: RUN_ID, status: 'partial_success' });
		expect(asList.json('SourceToDocs')[0]).toEqual({ run_id: RUN_ID, status: 'partial_success' });
	});

	it('timed_out, idempotent_replay and the Map Columns notes survive Selected Fields', async () => {
		const api = await startApi((request) => (request.method === 'POST' ? ok({ run: runPayload({ status: 'pending' }) }, 201) : ok({ run: runPayload({ status: 'processing' }) })));
		const waited = await through(api, s2dConnected({ output: 'selected', outputFields: ['status'], waitForCompletion: true, maxWait: 2, pollEvery: 2 }, V11));
		expect(waited.json('SourceToDocs')[0]).toEqual({ status: 'processing', run_id: RUN_ID, timed_out: true });

		const mapped = await through(
			(await startApi()),
			s2dMapped({ 'Client name': '={{ $json.clients.name }}', ...otherShown }, { output: 'selected', outputFields: ['run_id'] }, 'defineBelow', V11),
		);
		expect(mapped.json('SourceToDocs')[0]).toEqual({ run_id: RUN_ID, empty_columns: ['Client name'] });
	});

	it('Simplified keeps empty_columns and empty_rows, as Map Columns reports them', async () => {
		const api = await startApi();

		const result = await through(api, s2dMapped({ 'Client name': '={{ $json.clients.name }}', ...otherShown }, {}, 'defineBelow', V11));

		expect(result.json('SourceToDocs')[0]).toMatchObject({ empty_columns: ['Client name'] });
		expect(result.json('SourceToDocs')[0]).toHaveProperty('warnings');
	});

	it('missing_split_keys survives Simplified output and Selected Fields, like empty_columns', async () => {
		const unkeyed = s2dMapped({ ...otherShown });
		const withOutput = (parameters: INodeParameters) => s2dMapped({ ...otherShown }, parameters, 'defineBelow', V11);

		const simplified = await through(await startApi(documentRouter(splitOn(['Client name']))), withOutput({}));
		expect(simplified.json('SourceToDocs')[0]).toMatchObject({ missing_split_keys: ['Client name'], empty_columns: ['Client name'] });

		const selected = await through(await startApi(documentRouter(splitOn(['Client name']))), withOutput({ output: 'selected', outputFields: ['run_id'] }));
		expect(selected.json('SourceToDocs')[0]).toEqual({ run_id: RUN_ID, empty_columns: ['Client name'], missing_split_keys: ['Client name'] });

		// Version 1 is not left out: the note is not an output field.
		const v1 = await through(await startApi(documentRouter(splitOn(['Client name']))), unkeyed);
		expect(v1.json('SourceToDocs')[0]).toMatchObject({ missing_split_keys: ['Client name'] });
	});

	it('Selected Fields with nothing selected refuses before any request, and names the way out', async () => {
		const api = await startApi();

		const result = await through(api, s2dConnected({ output: 'selected', outputFields: '=' }, V11));

		expect(api.requests).toHaveLength(0);
		expect(result.errorOf('SourceToDocs')?.message).toBe("'Output' is Selected Fields, but 'Fields' is empty");
		expect(result.errorOf('SourceToDocs')?.description).toContain('Nothing was sent');
	});

	it('an unknown field name is refused before any request, naming it', async () => {
		const api = await startApi();

		const result = await through(api, s2dConnected({ output: 'selected', outputFields: '=status, nope' }, V11));

		expect(api.requests).toHaveLength(0);
		expect(result.errorOf('SourceToDocs')?.message).toBe("Unknown field in 'Fields': 'nope'");
	});

	it('Run → Get refuses an empty selection too', async () => {
		const api = await startApi();

		const result = await through(api, runGet({ output: 'selected', outputFields: '=' }, V11));

		expect(result.errorOf('SourceToDocs')?.message).toBe("'Output' is Selected Fields, but 'Fields' is empty");
		expect(api.requests).toHaveLength(0);
	});
});

describe('version 1.1 Get Many: Return All and Limit', () => {
	const projects = ['a', 'b', 'c'].map((n, i) => ({ id: `a000000${i}-0000-4000-8000-000000000001`, name: n, timezone: null }));
	const documents = ['a', 'b', 'c'].map((n, i) => ({ id: `d000000${i}-0000-4000-8000-000000000001`, project_id: 'p', name: n, type: 'google_docs' }));
	const router: Router = (request) => (request.path.endsWith('/projects') ? ok({ projects }) : ok({ documents }));
	const projectMany = (extra: INodeParameters = {}, node: Partial<TestNode> = {}) =>
		({ ...s2d({ resource: 'project', operation: 'getMany', ...extra }), ...node }) as TestNode;
	const documentMany = (extra: INodeParameters = {}, node: Partial<TestNode> = {}) =>
		({ ...s2d({ resource: 'document', operation: 'getMany', projectId: 'a0000000-0000-4000-8000-000000000001', ...extra }), ...node }) as TestNode;

	it.each([
		['Project', projectMany, projects],
		['Document', documentMany, documents],
	])('%s: Return All is on by default and returns everything', async (_name, node, all) => {
		const api = await startApi(router);

		const result = await through(api, node({}, V11));

		expect(result.json('SourceToDocs')).toEqual(all);
	});

	it.each([
		['Project', projectMany, projects],
		['Document', documentMany, documents],
	])('%s: Return All off with Limit 1 returns the first one, and the API is still asked once', async (_name, node, all) => {
		const api = await startApi(router);

		const result = await through(api, node({ returnAll: false, limit: 1 }, V11));

		expect(result.json('SourceToDocs')).toEqual([all[0]]);
		expect(api.requests).toHaveLength(1);
	});

	it('a Limit above the length returns all of it; Return All on ignores Limit', async () => {
		const api = await startApi(router);

		const big = await through(api, projectMany({ returnAll: false, limit: 99 }, V11));
		const ignored = await through(api, projectMany({ returnAll: true, limit: 1 }, V11));

		expect(big.json('SourceToDocs')).toEqual(projects);
		expect(ignored.json('SourceToDocs')).toEqual(projects);
	});

	it('the Limit applies per input item (2 items, Limit 2: 4 items out)', async () => {
		const api = await startApi(router);

		const result = await through(api, projectMany({ returnAll: false, limit: 2 }, V11), [{ json: {} }, { json: {} }]);

		expect(result.items('SourceToDocs').map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }, { item: 1 }]);
	});

	it('a Limit that is not a whole number of 1 or more is an error, not a silent cut', async () => {
		const api = await startApi(router);

		for (const bad of ['=0', '=1.5', '=abc']) {
			const result = await through(api, projectMany({ returnAll: false, limit: bad }, V11));
			expect(result.errorOf('SourceToDocs')?.message).toContain("'Limit' must be a whole number of 1 or more");
		}
	});

	it('v1 returns everything whatever Return All and Limit a stored workflow might hold', async () => {
		const api = await startApi(router);

		const project = await through(api, projectMany({ returnAll: false, limit: 1 }));
		const document = await through(api, documentMany({ returnAll: false, limit: 1 }));

		expect(project.json('SourceToDocs')).toEqual(projects);
		expect(document.json('SourceToDocs')).toEqual(documents);
	});
});
