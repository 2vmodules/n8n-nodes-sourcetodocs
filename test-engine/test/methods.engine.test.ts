/**
 * The node's pickers (load options, list search, resource mapping) run through n8n-core's own
 * `LoadOptionsContext`, with the real expression engine, our credentials helper and the fake
 * API. Moved from the stubbed methods and negativeCases tests.
 *
 * The parameters passed are what the editor holds while a picker loads: `resource`, `operation`
 * and `rowsFrom` matter, because n8n returns a parameter's default while its displayOptions hide
 * it (a stub never models that).
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	DS_ID,
	TOKEN,
	callMethod,
	documentPayload,
	failure,
	ok,
	useFakeApis,
	type FakeApi,
	type FakeReply,
	type Router,
} from './harness';

const startApi = useFakeApis();

const locator = (value: string) => ({ __rl: true, mode: 'id', value });
const generating = { resource: 'document', operation: 'generate' };
const withDocument = (value = DOC_ID) => ({ ...generating, documentId: locator(value) });

const docOf = (overrides: Record<string, unknown>) => ({
	document: { ...documentPayload.data.document, ...overrides },
});

const documentRouter =
	(document: unknown = documentPayload.data): Router =>
	(request) =>
		request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`
			? ok(document)
			: failure(404, 'not_found', 'Resource not found.');

const refuse =
	(reply: FakeReply): Router =>
	() =>
		reply;

interface Option {
	name: string;
	value: string;
	description?: string;
	disabled?: boolean;
}

describe('getProjects', () => {
	it('maps the projects payload to options, sending the credential token', async () => {
		const api = await startApi(() =>
			ok({
				projects: [
					{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Marketing', timezone: 'UTC' },
					{ id: 'a0000000-0000-4000-8000-000000000002', name: 'Sales', timezone: null },
				],
			}),
		);

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getProjects',
			baseUrl: api.baseUrl,
			parameters: { resource: 'document', operation: 'getMany' },
		});

		expect(options).toEqual([
			{ name: 'Marketing', value: 'a0000000-0000-4000-8000-000000000001' },
			{ name: 'Sales', value: 'a0000000-0000-4000-8000-000000000002' },
		]);
		expect(api.requests).toHaveLength(1);
		expect(api.requests[0]).toMatchObject({ method: 'GET', path: `${API_PATH}/projects` });
		expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
	});
});

describe('getDataSets', () => {
	it('returns nothing, and sends nothing, until a document is picked', async () => {
		const api = await startApi(documentRouter());

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDataSets',
			baseUrl: api.baseUrl,
			parameters: withDocument(''),
		});

		expect(options).toEqual([]);
		expect(api.requests).toHaveLength(0);
	});

	it("describes each data set by its columns' names, joined, and says so for one with no columns", async () => {
		const api = await startApi(
			documentRouter(
				docOf({
					data_sets: [
						{
							id: 'ds-1',
							name: 'Customers',
							alias: 'customers',
							data_source_id: 'src-1',
							source_table_id: 'tbl-1',
							columns: [
								{ name: 'Client name', type: 'text', selected: true },
								{ name: 'Amount', type: 'number', selected: true },
							],
						},
						{ id: 'ds-2', name: 'Empty', alias: 'empty', data_source_id: 'src-1', source_table_id: null, columns: [] },
					],
				}),
			),
		);

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDataSets',
			baseUrl: api.baseUrl,
			parameters: withDocument(),
		});

		expect(options).toEqual([
			{ name: 'Customers', value: 'ds-1', description: 'Client name, Amount' },
			{ name: 'Empty', value: 'ds-2', description: 'This data set has no columns yet' },
		]);
		expect(api.requests.map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}`]);
	});

	it('reads the picked document out of a URL-mode locator, whatever its host', async () => {
		const api = await startApi(documentRouter());

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDataSets',
			baseUrl: api.baseUrl,
			parameters: {
				...generating,
				documentId: { __rl: true, mode: 'url', value: `https://app.sourcetodocs.com/documents/show/${DOC_ID}` },
			},
		});

		expect(options.map((o) => o.name)).toEqual(['Clients', 'Lines']);
		expect(api.requests[0].path).toBe(`${API_PATH}/documents/${DOC_ID}`);
	});
});

describe('getDistributions', () => {
	const distributions = [
		{ id: 'd0000000-0000-4000-8000-000000000001', type: 'google_drive', is_enabled: true, label: 'Google Drive · Reports' },
		{ id: 'd0000000-0000-4000-8000-000000000002', type: 'download', is_enabled: false, label: 'Download' },
	];

	it('returns nothing, and sends nothing, until a document is picked', async () => {
		const api = await startApi(refuse(failure(404, 'not_found', 'Resource not found.')));

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDistributions',
			baseUrl: api.baseUrl,
			parameters: withDocument(''),
		});

		expect(options).toEqual([]);
		expect(api.requests).toHaveLength(0);
	});

	it('lists only the enabled distributions, by label', async () => {
		const api = await startApi(documentRouter(docOf({ split: null, distributions })));

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDistributions',
			baseUrl: api.baseUrl,
			parameters: withDocument(),
		});

		expect(options).toEqual([{ name: 'Google Drive · Reports', value: 'd0000000-0000-4000-8000-000000000001' }]);
	});

	it('answers with one disabled notice instead of a choice for a split-configured document', async () => {
		const api = await startApi(
			documentRouter(
				docOf({
					split: { enabled: true, driver_data_source_id: 'src-1', driver_source_table_id: 'tbl-1' },
					distributions,
				}),
			),
		);

		const options = await callMethod<Option[]>({
			kind: 'loadOptions',
			name: 'getDistributions',
			baseUrl: api.baseUrl,
			parameters: withDocument(),
		});

		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({ value: '', disabled: true });
		expect(options[0].name.toLowerCase()).toContain('split-configured');
	});
});

describe('searchDocuments', () => {
	const documents = [
		{ id: 'd-1', project_id: 'a0000000-0000-4000-8000-000000000001', name: 'Weekly Report' },
		{ id: 'd-2', project_id: 'a0000000-0000-4000-8000-000000000001', name: 'Invoice' },
	];
	const projectRouter: Router = (request) =>
		request.path === `${API_PATH}/projects/a0000000-0000-4000-8000-000000000001/documents` ? ok({ documents }) : failure(404, 'not_found', 'Resource not found.');
	const search = (api: FakeApi, projectId: string, filter?: string) =>
		callMethod<{ results: Array<{ name: string; value: string; url: string }> }>({
			kind: 'listSearch',
			name: 'searchDocuments',
			baseUrl: api.baseUrl,
			filter,
			parameters: { ...generating, projectId },
		});

	it('returns nothing, and sends nothing, until a project is picked', async () => {
		const api = await startApi(projectRouter);

		expect(await search(api, '')).toEqual({ results: [] });
		expect(api.requests).toHaveLength(0);
	});

	it("filters the project's documents by name, case-insensitively, and builds each one's app URL from the Base URL origin", async () => {
		const api = await startApi(projectRouter);

		expect(await search(api, 'a0000000-0000-4000-8000-000000000001', 'WEEK')).toEqual({
			results: [{ name: 'Weekly Report', value: 'd-1', url: `${api.origin}/documents/show/d-1` }],
		});
	});

	it('lists everything for an empty filter', async () => {
		const api = await startApi(projectRouter);

		const { results } = await search(api, 'a0000000-0000-4000-8000-000000000001', '');

		expect(results.map((r) => r.value)).toEqual(['d-1', 'd-2']);
	});
});

describe('getColumns (the Map Columns resource mapper)', () => {
	const mapped = (documentId: string, mappedDataSetId: string) => ({
		...generating,
		rowsFrom: 'mapped',
		documentId: locator(documentId),
		mappedDataSetId,
	});
	const columnsOf = async (api: FakeApi, parameters: Record<string, unknown>) =>
		callMethod<{ fields: Array<{ id: string; type: string; removed: boolean; display: boolean; required: boolean }> }>({
			kind: 'resourceMapping',
			name: 'getColumns',
			baseUrl: api.baseUrl,
			parameters: parameters as never,
		});
	const dataSetWith = (columns: unknown[]) =>
		docOf({
			data_sets: [{ id: DS_ID, name: 'Clients', alias: 'clients', data_source_id: 's', source_table_id: 't', columns }],
		});

	it('lists the data set columns in order, typed by their column type (number and bool as strings, so the editor seeds no 0 or false), with an unselected one removed', async () => {
		const api = await startApi(documentRouter());

		const { fields } = await columnsOf(api, mapped(DOC_ID, DS_ID));

		expect(fields.map((f) => [f.id, f.type, f.removed])).toEqual([
			['Client name', 'string', false],
			['Amount', 'string', false],
			['Due', 'dateTime', false],
			['Paid', 'string', false],
			['Owner', 'string', true],
		]);
		expect(fields.every((f) => f.display && !f.required)).toBe(true);
	});

	it('removes no column when the data set selects none', async () => {
		const api = await startApi(
			documentRouter(dataSetWith([{ name: 'A', type: 'text', selected: false }, { name: 'B', type: 'text', selected: false }])),
		);

		const { fields } = await columnsOf(api, mapped(DOC_ID, DS_ID));

		expect(fields.map((f) => f.removed)).toEqual([false, false]);
	});

	it('picks the widget from every column type, a plain string for select, file and relation, and marks no field required or matchable', async () => {
		const api = await startApi(
			documentRouter(
				dataSetWith([
					{ name: 'Client name', type: 'text', selected: true },
					{ name: 'Amount', type: 'number', selected: false },
					{ name: 'Paid', type: 'bool', selected: true },
					{ name: 'Due', type: 'date', selected: false },
					{ name: 'Stage', type: 'select', selected: false },
					{ name: 'Logo', type: 'file', selected: false },
					{ name: 'Owner', type: 'relation', selected: false },
				]),
			),
		);

		const { fields } = await columnsOf(api, mapped(DOC_ID, DS_ID));

		expect(Object.fromEntries(fields.map((f) => [f.id, f.type]))).toEqual({
			'Client name': 'string',
			Amount: 'string',
			Paid: 'string',
			Due: 'dateTime',
			Stage: 'string',
			Logo: 'string',
			Owner: 'string',
		});
		expect(fields.map((f) => f.removed)).toEqual([false, true, false, true, true, true, true]);
		expect(fields.every((f) => !f.required && !(f as { defaultMatch?: boolean }).defaultMatch)).toBe(true);
	});

	describe('select choices', () => {
		const fieldsOf = async (columns: unknown[]) =>
			(await columnsOf(await startApi(documentRouter(dataSetWith(columns))), mapped(DOC_ID, DS_ID))).fields as Array<
				Record<string, unknown>
			>;

		it('a select column with published choices is an options field listing them in order', async () => {
			const [stage] = await fieldsOf([{ name: 'Stage', type: 'select', selected: true, choices: ['Open', 'Won', 'Lost'] }]);

			expect(stage).toMatchObject({
				id: 'Stage',
				type: 'options',
				display: true,
				removed: false,
				options: [
					{ name: 'Open', value: 'Open' },
					{ name: 'Won', value: 'Won' },
					{ name: 'Lost', value: 'Lost' },
				],
			});
		});

		it.each([
			['null choices', { choices: null }],
			['no choices field (an older API)', {}],
			['an empty list', { choices: [] }],
		])('a select column with %s stays free text', async (_name, extra) => {
			const [stage] = await fieldsOf([{ name: 'Stage', type: 'select', selected: true, ...extra }]);

			expect(stage.type).toBe('string');
			expect(stage).not.toHaveProperty('options');
		});

		it('choices on a column that is not a select are ignored', async () => {
			const [client] = await fieldsOf([{ name: 'Client name', type: 'text', selected: true, choices: ['x'] }]);

			expect(client.type).toBe('string');
			expect(client).not.toHaveProperty('options');
		});
	});

	it('types a column whose type it does not know as a string', async () => {
		const api = await startApi(documentRouter(dataSetWith([{ name: 'A', type: 'hologram', selected: true }])));

		const { fields } = await columnsOf(api, mapped(DOC_ID, DS_ID));

		expect(fields).toHaveLength(1);
		expect(fields[0].type).toBe('string');
	});

	it('returns no fields, and sends nothing, while no data set is picked', async () => {
		const api = await startApi(documentRouter());

		expect(await columnsOf(api, mapped(DOC_ID, ''))).toEqual({ fields: [] });
		expect(api.requests).toHaveLength(0);
	});

	it('returns no fields when the picked data set is not in the document', async () => {
		const api = await startApi(documentRouter());

		expect(await columnsOf(api, mapped(DOC_ID, 'ds-other'))).toEqual({ fields: [] });
	});

	it('returns no fields while the data set picker is hidden (Rows Come From is not Map Columns)', async () => {
		const api = await startApi(documentRouter());

		// n8n resolves a hidden parameter to its default, so the loader sees no data set.
		expect(await columnsOf(api, { ...mapped(DOC_ID, DS_ID), rowsFrom: 'connected' })).toEqual({ fields: [] });
		expect(api.requests).toHaveLength(0);
	});
});

/**
 * How n8n shows a loader failure: whatever the loader throws reaches the editor. A loader that
 * returned `[]` instead would look like "nothing here", so each must REJECT with the API's
 * message.
 */
const pickers: Array<{ name: string; call: (api: FakeApi) => Promise<unknown>; scopedToDeletable: boolean }> = [
	{
		name: 'Project (getProjects)',
		scopedToDeletable: false,
		call: (api) =>
			callMethod({ kind: 'loadOptions', name: 'getProjects', baseUrl: api.baseUrl, parameters: { resource: 'document', operation: 'getMany' } }),
	},
	{
		name: 'Document (searchDocuments)',
		scopedToDeletable: true,
		call: (api) =>
			callMethod({ kind: 'listSearch', name: 'searchDocuments', baseUrl: api.baseUrl, parameters: { ...generating, projectId: 'a0000000-0000-4000-8000-000000000001' } }),
	},
	{
		name: 'Data Set (getDataSets)',
		scopedToDeletable: true,
		call: (api) => callMethod({ kind: 'loadOptions', name: 'getDataSets', baseUrl: api.baseUrl, parameters: withDocument() }),
	},
	{
		name: 'Deliver To (getDistributions)',
		scopedToDeletable: true,
		call: (api) => callMethod({ kind: 'loadOptions', name: 'getDistributions', baseUrl: api.baseUrl, parameters: withDocument() }),
	},
	{
		name: 'Columns (getColumns)',
		scopedToDeletable: true,
		call: (api) =>
			callMethod({
				kind: 'resourceMapping',
				name: 'getColumns',
				baseUrl: api.baseUrl,
				parameters: { ...generating, rowsFrom: 'mapped', documentId: locator(DOC_ID), mappedDataSetId: DS_ID },
			}),
	},
];

describe('the pickers when the API answers with an error', () => {
	describe.each([
		['the document was deleted or the token cannot see it (404)', failure(404, 'not_found', 'Resource not found.'), '404', 'Resource not found.'],
		['the token was revoked (401)', failure(401, 'auth', 'Invalid API token.'), '401', 'Invalid API token.'],
		['the API fails (500)', failure(500, 'server', 'Server Error'), '500', 'Server Error'],
	])('%s', (_title, reply, httpCode, message) => {
		// A project list is not scoped to anything that can be deleted, so it has no 404.
		it.each(pickers.filter((picker) => httpCode !== '404' || picker.scopedToDeletable))(
			'$name rejects with the API message, not an empty list',
			async ({ call }) => {
				const api = await startApi(refuse(reply));

				const failed = await call(api).then(
					() => undefined,
					(error: unknown) => error as { name: string; message: string; httpCode: string },
				);

				expect(failed?.name).toBe('NodeApiError');
				expect(failed?.message).toBe(message);
				expect(failed?.httpCode).toBe(httpCode);
			},
		);
	});

	it('names the unreachable API when a proxy answers 502 with an HTML page', async () => {
		const api = await startApi(refuse({ status: 502, raw: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } }));

		const failed = await pickers[3].call(api).then(
			() => undefined,
			(error: unknown) => error as { name: string; message: string },
		);

		expect(failed?.name).toBe('NodeApiError');
		expect(failed?.message).toContain('the API is unreachable');
	});
});
