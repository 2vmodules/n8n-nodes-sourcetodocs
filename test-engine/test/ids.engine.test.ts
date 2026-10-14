/**
 * Ids and inline_data are safe, through n8n's own engine: hostile
 * ids through an expression and through `$fromAI`, and Rows edge cases such as a
 * `__proto__` Data Set id, plus the valid ids that must keep working in every mode.
 *
 * A literal ID-mode value is checked by n8n before the run (`WorkflowHasIssuesError`), so every
 * hostile value here reaches the node through an expression. By URL and By ID have their own
 * literal-value tests at the end, so that n8n's own pre-run validation runs.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	DS2_ID,
	DS_ID,
	defaultRouter,
	failure,
	ok,
	runPayload,
	emit,
	runWorkflow,
	s2d,
	s2dJson,
	s2dMapped,
	callMethod,
	bodyOf,
	useFakeApis,
	type FakeApi,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

const RUN_UUID = 'b0000000-0000-4000-8000-000000000001';
const DIST_UUID = 'd0000000-0000-4000-8000-000000000001';
const PROJECT_UUID = 'a0000000-0000-4000-8000-000000000001';

/** What the engine keeps of a thrown node error: a plain copy with `name`, `description` and `context`. */
interface NodeErrorCopy {
	name: string;
	message: string;
	description?: string;
}

async function runWith(api: FakeApi, node: TestNode, items: unknown[]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

const HOSTILE = [
	`../documents/${DOC_ID}`,
	'abc?x=1',
	'abc#frag',
	`${RUN_UUID}/children`,
	'..%2F..%2Fprojects',
	'../../projects#',
	'',
	'   ',
];

/** Both ways a hostile id reaches a parameter: an expression on the item, and `$fromAI`. */
const WAYS = [
	['an expression', '={{ $json.id }}'],
	['$fromAI', "={{ $fromAI('id') }}"],
] as const;

const locator = (value: string, mode = 'id') => ({ __rl: true, mode, value });

/** Each way to put an id into one parameter of an operation, with the label the error must name. */
const TARGETS: Array<[string, string, (value: string) => TestNode]> = [
	['Run → Get', 'Run ID', (value) => s2d({ resource: 'run', operation: 'get', runId: value })],
	['Document → Get', 'Document', (value) => s2d({ resource: 'document', operation: 'get', documentId: locator(value) })],
	['Document → Get Many', 'Project', (value) => s2d({ resource: 'document', operation: 'getMany', projectId: value })],
	['Generate (Document)', 'Document', (value) => s2d({ documentId: locator(value), rowsFrom: 'connected' })],
	['Generate (Document, From List)', 'Document', (value) => s2d({ documentId: locator(value, 'list'), rowsFrom: 'connected' })],
	['Generate (Data Set, This Workflow)', 'Data Set', (value) => s2dJson([{ dataSetId: value, rows: '[]' }])],
	['Generate (Data Set, Map Columns)', 'Data Set', (value) => s2dMapped(null, { mappedDataSetId: value }, 'autoMapInputData')],
	[
		'Generate (Data Set, Additional Data Sets)',
		'Data Set',
		(value) => s2dMapped({ 'Client name': 'x' }, { additionalDataSets: { values: [{ dataSetId: value, rows: '[]' }] } }),
	],
];

describe('hostile ids are refused before any request', () => {
	for (const [way, expression] of WAYS) {
		describe(`through ${way}`, () => {
			for (const [operation, label, build] of TARGETS) {
				it.each(HOSTILE)(`${operation} refuses %j, naming ${label}`, async (hostile) => {
					const api = await startApi();

					const result = await runWith(api, build(expression), [{ json: { id: hostile } }]);

					const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
					expect(error?.name).toBe('NodeOperationError');
					// An empty Data Set has its own "no Data Set selected" message; every other value names the parameter.
					if (hostile.trim() === '' && label === 'Data Set') {
						expect(error.message).toMatch(/has no 'Data Set' selected|'Data Set' is not a valid ID/);
					} else {
						expect(error.message).toContain(`'${label}' is not a valid ID`);
						expect(error.message).toContain(JSON.stringify(hostile.length > 40 ? `${hostile.slice(0, 40)}...` : hostile));
					}
					expect(api.requests).toHaveLength(0);
				});
			}
		});
	}

	it('refuses each Deliver To id that is not an ID, naming Deliver To, and sends nothing', async () => {
		const api = await startApi();
		const node = s2d({ rowsFrom: 'connected', distributionIds: '={{ $json.ids }}' });

		const result = await runWith(api, node, [{ json: { ids: [DIST_UUID, '../../projects#'] } }]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error?.name).toBe('NodeOperationError');
		expect(error.message).toContain("'Deliver To' is not a valid ID: \"../../projects#\"");
		expect(api.requests).toHaveLength(0);
	});

	it('refuses a Deliver To that is not a list', async () => {
		const api = await startApi();
		const node = s2d({ rowsFrom: 'connected', distributionIds: '={{ $json.ids }}' });

		const result = await runWith(api, node, [{ json: { ids: DIST_UUID } }]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error?.message).toContain("'Deliver To' must be a list of IDs");
		expect(api.requests).toHaveLength(0);
	});

	it('quotes a long value cut to 40 characters, not the whole of it', async () => {
		const api = await startApi();
		const long = `${'x'.repeat(40)}${'SECRET_TAIL'.repeat(20)}`;

		const result = await runWith(api, s2d({ resource: 'run', operation: 'get', runId: '={{ $json.id }}' }), [{ json: { id: long } }]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.message).toBe(`'Run ID' is not a valid ID: "${'x'.repeat(40)}..."`);
		expect(api.requests).toHaveLength(0);
	});

	it('refuses a value that is not text (an object) without echoing it', async () => {
		const api = await startApi();

		const result = await runWith(api, s2d({ resource: 'run', operation: 'get', runId: '={{ $json.id }}' }), [{ json: { id: { a: 1 } } }]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.message).toMatch(/^'Run ID' is not a valid ID: an? /);
		expect(api.requests).toHaveLength(0);
	});

	it('refuses the one bad item of several and still sends nothing for it (Run → Get)', async () => {
		const api = await startApi(defaultRouter({ status: 'succeeded' }));
		const node = s2d({ resource: 'run', operation: 'get', runId: '={{ $json.id }}' }, { continueOnFail: true });

		const result = await runWith(api, node, [{ json: { id: RUN_UUID } }, { json: { id: '../documents/x' } }]);

		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/runs/${RUN_UUID}`]);
		expect(result.json('SourceToDocs')[1].error).toContain("'Run ID' is not a valid ID");
	});
});

describe('Data Set ids and Rows edge cases', () => {
	const rowsCase = (rows: string) => s2dJson([{ dataSetId: DS_ID, rows }]);

	it.each([
		['undefined', '={{ $json.lines }}', /'Rows' of entry 1 in 'Data Sets' must be a JSON array of objects/],
		['a string that is not JSON', '={{ "not json" }}', /'Rows' of entry 1 in 'Data Sets' is not valid JSON/],
		['an object', '={{ $json }}', /'Rows' of entry 1 in 'Data Sets' must be a JSON array of objects/],
	])('Rows that is %s gives today\'s error and sends nothing', async (_name, rows, message) => {
		const api = await startApi();

		const result = await runWith(api, rowsCase(rows), [{ json: { other: 1 } }]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error?.name).toBe('NodeOperationError');
		expect(error.message).toMatch(message);
		expect(api.requests).toHaveLength(0);
	});

	it.each(['refuse', 'drop'])('a __proto__ Data Set id is refused under Unknown Fields %s, not sent as {}', async (unknownKeys) => {
		const api = await startApi();

		const result = await runWith(api, s2dJson([{ dataSetId: '={{ $json.ds }}', rows: '[{"Sku":"a"}]' }], { unknownKeys }), [
			{ json: { ds: '__proto__' } },
		]);

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.message).toContain("'Data Set' is not a valid ID: \"__proto__\"");
		expect(api.requests).toHaveLength(0);
	});
});

describe('valid ids still work in every mode', () => {
	it('Generate: By ID, By URL with a foreign host, and From List all reach the same document', async () => {
		for (const documentId of [
			locator(DOC_ID),
			locator('={{ $json.url }}', 'url'),
			locator(DOC_ID, 'list'),
			locator('={{ "  " + $json.id + "  " }}'),
			locator('={{ $json.id }}'),
		]) {
			const api = await startApi();

			const result = await runWith(api, s2d({ documentId, rowsFrom: 'connected' }), [{ json: { id: DOC_ID, url: `https://other-host.example/documents/show/${DOC_ID}` } }]);

			expect(result.errorOf('SourceToDocs')).toBeUndefined();
			expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${API_PATH}/documents/${DOC_ID}/runs`]);
		}
	});

	it('Generate through $fromAI: a valid UUID is sent', async () => {
		const api = await startApi();

		const result = await runWith(api, s2d({ documentId: locator("={{ $fromAI('id') }}"), rowsFrom: 'connected' }), [{ json: { id: DOC_ID } }]);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()[0].path).toBe(`${API_PATH}/documents/${DOC_ID}/runs`);
	});

	it('Document → Get By URL with a foreign host reads the document the UUID names', async () => {
		const api = await startApi();

		const result = await runWith(
			api,
			s2d({ resource: 'document', operation: 'get', documentId: locator('={{ $json.url }}', 'url') }),
			[{ json: { url: `https://other-host.example/documents/show/${DOC_ID}` } }],
		);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}`]);
	});

	it('Run → Get and Document → Get Many take expression ids; a capital-letter UUID passes unchanged', async () => {
		const upper = RUN_UUID.toUpperCase();
		const api = await startApi(defaultRouter({ status: 'succeeded' }));
		await runWith(api, s2d({ resource: 'run', operation: 'get', runId: '={{ $json.id }}' }), [{ json: { id: ` ${upper} ` } }]);
		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/runs/${upper}`]);

		const projects = await startApi(() => ({ status: 200, body: { success: true, data: { documents: [] } } }));
		await runWith(projects, s2d({ resource: 'document', operation: 'getMany', projectId: '={{ $json.id }}' }), [{ json: { id: PROJECT_UUID } }]);
		expect(projects.requests.map((r) => r.path)).toEqual([`${API_PATH}/projects/${PROJECT_UUID}/documents`]);
	});

	it('Generate: Data Set and Deliver To ids that are UUIDs are sent in the body, in all three Rows modes', async () => {
		const api = await startApi();
		const distributionIds = [DIST_UUID];

		await runWith(api, s2dJson([{ dataSetId: DS_ID, rows: '[{"Sku":"a"}]' }], { unknownKeys: 'refuse', distributionIds }), [{ json: {} }]);
		await runWith(api, s2dMapped({ 'Client name': 'x' }, { additionalDataSets: { values: [{ dataSetId: DS2_ID, rows: '[{"Sku":"b"}]' }] }, unknownKeys: 'refuse', distributionIds }), [{ json: {} }]);
		await runWith(api, s2dMapped(null, { unknownKeys: 'refuse', distributionIds }, 'autoMapInputData'), [{ json: { 'Client name': 'y' } }]);

		expect(api.posts().map((p) => bodyOf(p))).toEqual([
			{ inline_data: { [DS_ID]: [{ Sku: 'a' }] }, distribution_ids: distributionIds },
			{ inline_data: { [DS_ID]: [{ 'Client name': 'x' }], [DS2_ID]: [{ Sku: 'b' }] }, distribution_ids: distributionIds },
			{ inline_data: { [DS_ID]: [{ 'Client name': 'y' }] }, distribution_ids: distributionIds },
		]);
	});
});

describe('the pickers refuse a hostile id before any request', () => {
	const generating = { resource: 'document', operation: 'generate' };
	const mapping = { ...generating, rowsFrom: 'mapped', mappedDataSetId: DS_ID };

	it.each([
		['loadOptions', 'getDataSets', generating],
		['loadOptions', 'getDistributions', generating],
		['resourceMapping', 'getColumns', mapping],
	] as const)('%s.%s refuses a Document that is not an ID', async (kind, name, base) => {
		const api = await startApi();

		await expect(
			callMethod({ kind, name, baseUrl: api.baseUrl, parameters: { ...base, documentId: locator('../../projects#') } }),
		).rejects.toThrow("'Document' is not a valid ID: \"../../projects#\"");
		expect(api.requests).toHaveLength(0);
	});

	it('listSearch.searchDocuments refuses a Project that is not an ID', async () => {
		const api = await startApi();

		await expect(
			callMethod({ kind: 'listSearch', name: 'searchDocuments', baseUrl: api.baseUrl, parameters: { ...generating, projectId: 'abc?x=1' } }),
		).rejects.toThrow("'Project' is not a valid ID: \"abc?x=1\"");
		expect(api.requests).toHaveLength(0);
	});

	it('a picked UUID still loads (Document, Project)', async () => {
		const api = await startApi();

		await callMethod({ kind: 'loadOptions', name: 'getDataSets', baseUrl: api.baseUrl, parameters: { ...generating, documentId: locator(DOC_ID) } });

		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}`]);
	});
});

describe('an id the API itself returns is encoded before it goes back into a path', () => {
	it('lists a finished batch\'s children under the encoded batch id', async () => {
		const odd = 'a/b?c#d';
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: odd, kind: 'batch', status: 'succeeded' }) }, 201);
			if (request.path === `${API_PATH}/runs/a%2Fb%3Fc%23d/children`) return ok({ runs: [] });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runWith(api, s2d({ rowsFrom: 'connected', waitForCompletion: true }), [{ json: {} }]);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}/runs`, `${API_PATH}/runs/a%2Fb%3Fc%23d/children`]);
	});
});

describe('By URL and By ID with literal values, through n8n\'s own pre-run validation', () => {
	const url = (path: string) => `https://app.sourcetodocs.com${path}`;
	const show = (id: string) => `/documents/show/${id}`;

	it.each([
		['a plain document URL', url(show(DOC_ID))],
		['a trailing slash', `${url(show(DOC_ID))}/`],
		['a query', `${url(show(DOC_ID))}?tab=x`],
		['a fragment', `${url(show(DOC_ID))}#frag`],
		['a foreign host with a port', `https://other-host.example:8443${show(DOC_ID)}`],
	])('By URL accepts %s and posts to that document', async (_name, value) => {
		const api = await startApi();

		const result = await runWith(api, s2d({ documentId: locator(value, 'url'), rowsFrom: 'connected' }), [{ json: {} }]);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${API_PATH}/documents/${DOC_ID}/runs`]);
	});

	it('By URL accepts an upper-case UUID and extracts it as written', async () => {
		const api = await startApi();

		await runWith(api, s2d({ documentId: locator(url(show(DOC_ID.toUpperCase())), 'url'), rowsFrom: 'connected' }), [{ json: {} }]);

		expect(api.posts()[0].path).toBe(`${API_PATH}/documents/${DOC_ID.toUpperCase()}/runs`);
	});

	it('By ID accepts an upper-case UUID', async () => {
		const api = await startApi();

		await runWith(api, s2d({ documentId: locator(DOC_ID.toUpperCase()), rowsFrom: 'connected' }), [{ json: {} }]);

		expect(api.posts()[0].path).toBe(`${API_PATH}/documents/${DOC_ID.toUpperCase()}/runs`);
	});

	it('Document → Get By URL with a query reads the right document', async () => {
		const api = await startApi();

		const result = await runWith(
			api,
			s2d({ resource: 'document', operation: 'get', documentId: locator(`${url(show(DOC_ID))}?tab=x`, 'url') }),
			[{ json: {} }],
		);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}`]);
	});

	it.each([
		['a path that is not /documents/show/<uuid>', url(`/projects/${DOC_ID}`)],
		['/documents/show/ with a non-UUID', url('/documents/show/not-a-uuid')],
		['/documents/show/ with a UUID and trailing characters', url(`${show(DOC_ID)}abc`)],
		['/documents/show/<uuid>/children', url(`${show(DOC_ID)}/children`)],
		['a path with no origin', show(DOC_ID)],
		['http instead of https', `http://app.sourcetodocs.com${show(DOC_ID)}`],
		['a UUID alone', DOC_ID],
	])('By URL refuses %s before the run, with no request', async (_name, value) => {
		const api = await startApi();

		const failure = await runWith(api, s2d({ documentId: locator(value, 'url'), rowsFrom: 'connected' }), [{ json: {} }]).then(
			() => undefined,
			(error: Error) => error,
		);

		expect(failure?.name).toBe('WorkflowHasIssuesError');
		expect(failure?.message).toContain('Not a SourceToDocs document URL');
		expect(api.requests).toHaveLength(0);
	});
});
