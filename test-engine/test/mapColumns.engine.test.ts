/**
 * Document → Generate with Rows Come From: Map Columns, through n8n's own engine: the real
 * expression engine resolves each mapped value against its own input item, and the fake API
 * records the request that reaches the wire. Moved from the stubbed mapColumns tests.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	DS2_ID,
	DS_ID,
	defaultRouter,
	documentRouter,
	splitOn,
	emit,
	failure,
	runWorkflow,
	columnsSchema,
	otherShown,
	s2dJson,
	s2dMapped,
	type RecordedRequest,
	bodyOf,
	useFakeApis,
	core,
	type FakeApi,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

async function mapColumns(api: FakeApi, items: unknown[], node: TestNode) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

/** The rows the API received for the mapped Data Set. */
const sentRows = (api: FakeApi, dataSetId = DS_ID) =>
	(api.posts()[0].body as { inline_data: Record<string, unknown[]> }).inline_data[dataSetId];

describe('Map Columns, Map Each Column Manually', () => {
	it('one item: the body is exactly the one resolved row, in one POST', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', Amount: '={{ $json.amount }}', Paid: '={{ $json.paid }}' });

		const result = await mapColumns(api, [{ json: { name: 'Acme', amount: 1200, paid: true } }], node);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		// The document is read once, for the split key check; the run is one POST.
		expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`GET ${API_PATH}/documents/${DOC_ID}`,
			`POST ${API_PATH}/documents/${DOC_ID}/runs`,
		]);
		expect(bodyOf(api.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ 'Client name': 'Acme', Amount: 1200, Paid: true }] },
		});
		expect(result.json('SourceToDocs')).toHaveLength(1);
	});

	it('three items: one row per item, in order, each read against its own item', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', Amount: '={{ $json.amount * 10 }}' });

		const result = await mapColumns(
			api,
			[{ json: { name: 'Acme', amount: 1 } }, { json: { name: 'Globex', amount: 2 } }, { json: { name: 'Initech', amount: 3 } }],
			node,
		);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
		expect(sentRows(api)).toEqual([
			{ 'Client name': 'Acme', Amount: 10 },
			{ 'Client name': 'Globex', Amount: 20 },
			{ 'Client name': 'Initech', Amount: 30 },
		]);
		// One output item for the one run, paired to every input item.
		expect(result.items('SourceToDocs')).toHaveLength(1);
		expect(result.items('SourceToDocs')[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	it('resolves an expression that reads another node, per item index', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': "={{ $('Emit').item.json.name + '-' + $itemIndex }}" });

		await mapColumns(api, [{ json: { name: 'A' } }, { json: { name: 'B' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'A-0' }, { 'Client name': 'B-1' }]);
	});

	it('reads the document once, for the split key and not to drop keys: a mapped row has none to drop', async () => {
		const api = await startApi();

		await mapColumns(api, [{ json: { name: 'Acme' } }], s2dMapped({ 'Client name': '={{ $json.name }}' }, { unknownKeys: 'drop' }));

		expect(api.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
	});

	it('leaves out a column whose value is undefined and keeps null as given', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', Amount: '={{ $json.missing }}', Paid: null });

		await mapColumns(api, [{ json: { name: 'Acme' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'Acme', Paid: null }]);
	});

	it('does not send a column still hidden in the add-column list, only one that was added', async () => {
		const api = await startApi();
		// The editor seeds null for every hidden column (Owner is `removed` in the schema).
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', Owner: null, Paid: null });

		await mapColumns(api, [{ json: { name: 'Acme' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'Acme', Paid: null }]);
	});

	it('refuses, before any request, a run in which no row maps a value', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.clients.name }}' });

		const result = await mapColumns(api, [{ json: { clients: [{ name: 'x' }] } }, { json: { clients: [] } }], node);

		const error = result.errorOf('SourceToDocs') as unknown as { name: string; message: string; description: string };
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toBe("'Map Columns' has nothing to send: 'Client name', 'Amount', 'Due', 'Paid' resolved to nothing in every input item");
		expect(error.description).toMatch(/Split Out/);
		expect(error.description).toMatch(/\.map\(\.\.\.\)/);
		expect(error.description).toMatch(/resets the mapping.*Map Automatically/s);
		// The fix for an expression comes first, the mapping reset second.
		expect(error.description.indexOf('Split Out')).toBeLessThan(error.description.indexOf('resets the mapping'));
		expect(api.requests).toEqual([]);
	});

	it('an untouched mapping, with no value stored for any column, refuses too', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { name: 'A' } }], s2dMapped({}));

		expect(result.errorOf('SourceToDocs')?.message).toBe(
			"'Map Columns' has nothing to send: 'Client name', 'Amount', 'Due', 'Paid' resolved to nothing in every input item",
		);
		expect(api.requests).toEqual([]);
	});

	it('the guard names every shown column that resolved to nothing, mapped or untouched', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.clients.name }}', Amount: '={{ $json.missing }}' });

		const result = await mapColumns(api, [{ json: { clients: [] } }], node);

		expect(result.errorOf('SourceToDocs')?.message).toBe(
			"'Map Columns' has nothing to send: 'Client name', 'Amount', 'Due', 'Paid' resolved to nothing in every input item",
		);
		expect(api.requests).toEqual([]);
	});

	it('a mapping with no shown column keeps the plain "no column mapped" refusal', async () => {
		const api = await startApi();
		// Every column is hidden in the schema, so the only value there is is not sent.
		const hiddenSchema = columnsSchema.map((field) => ({ ...field, removed: true }));
		const node = s2dMapped({ Owner: 'x' }, { columns: { mappingMode: 'defineBelow', value: { Owner: 'x' }, matchingColumns: [], schema: hiddenSchema, attemptToConvertTypes: false, convertFieldsToString: false } });
		const result = await mapColumns(api, [{ json: {} }], node);

		const error = result.errorOf('SourceToDocs') as unknown as { message: string; description: string };
		expect(error.message).toBe("'Map Columns' has no column mapped");
		expect(error.description).toMatch(/resets the mapping/);
		expect(api.requests).toEqual([]);
	});

	it('sends the run when at least one row maps a value', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}' });

		await mapColumns(api, [{ json: {} }, { json: { name: 'Acme' } }], node);

		expect(sentRows(api)).toEqual([{}, { 'Client name': 'Acme' }]);
	});

	it('refuses, before any request, a Map Columns with no Data Set picked', async () => {
		const api = await startApi();
		// An expression, because n8n refuses an empty literal for a required parameter itself.
		const node = s2dMapped({ 'Client name': 'Acme' }, { mappedDataSetId: "={{ '' }}" });

		const result = await mapColumns(api, [{ json: {} }], node);

		expect(result.errorOf('SourceToDocs')?.message).toMatch(/has no 'Data Set' selected/);
		expect(api.requests).toEqual([]);
	});
});

describe('Map Columns, what a mapped value becomes on the wire', () => {
	const input = [{ json: { str: '12', empty: '' } }];

	// Values go as the mapping resolved them: `skipValidation` stops n8n converting by column type.
	it.each<[string, string, unknown, unknown]>([
		['a string that looks like a number stays a string', 'Amount', '={{ $json.str }}', '12'],
		['zero stays 0', 'Amount', 0, 0],
		['false stays false', 'Paid', false, false],
		['null stays null', 'Client name', null, null],
		['an empty-string expression is ""', 'Client name', '={{ $json.empty }}', ''],
		["an expression that is '' is \"\"", 'Client name', "={{ '' }}", ''],
		['a bare = is ""', 'Client name', '=', ''],
		['an empty literal in a number column is ""', 'Amount', '', ''],
		['a literal number in a text column stays a number', 'Client name', 0, 0],
		['a literal date string stays a string', 'Due', '2026-03-01', '2026-03-01'],
	])('%s', async (_title, column, mapped, expected) => {
		const api = await startApi();

		const result = await mapColumns(api, input, s2dMapped({ [column]: mapped, 'Client name': column === 'Client name' ? mapped : 'x' }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(sentRows(api)[0]).toMatchObject({ [column]: expected });
	});

	it('$now goes as an ISO string with the instance offset', async () => {
		const api = await startApi();

		await mapColumns(api, input, s2dMapped({ Due: '={{ $now }}' }));

		expect(sentRows(api)[0]).toEqual({
			Due: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/),
		});
	});

	it('an empty expression {{ }} raises "invalid syntax" and sends nothing', async () => {
		const api = await startApi();

		const result = await mapColumns(api, input, s2dMapped({ 'Client name': '={{ }}' }));

		expect(result.errorOf('SourceToDocs')?.message).toBe('invalid syntax');
		expect(api.requests).toEqual([]);
	});
});

describe('Map Columns, literal values n8n validates before the run', () => {
	it.each([
		['a non-number in a number column', { 'Client name': 'Acme', Amount: 'ten' }, "'Amount' expects a number but we got 'ten'"],
		['an empty literal in a date column', { 'Client name': 'Acme', Due: '' }, "'Due' expects a dateTime"],
	])('%s stops the workflow with WorkflowHasIssuesError before any request', async (_title, mapped, message) => {
		const api = await startApi();

		const rejection = await mapColumns(api, [{ json: {} }], s2dMapped(mapped)).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(core.WorkflowHasIssuesError);
		expect((rejection as Error).message).toContain(message);
		expect(api.requests).toEqual([]);
	});

	it('the same bad value through an expression reaches the node and the API judges it', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { v: 'ten' } }], s2dMapped({ Amount: '={{ $json.v }}' }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(sentRows(api)).toEqual([{ Amount: 'ten' }]);
	});
});

describe('Map Columns, a schema that has gone stale', () => {
	it('A: a column the document no longer has is sent, and the API refuses it with its own code', async () => {
		const defaults = defaultRouter();
		const api = await startApi((request, all) =>
			request.method === 'POST'
				? failure(422, 'validation', 'Unknown columns.', {
						code: ['inline_column_unknown'],
						unknown_keys: ['Old column'],
						data_set_id: DS_ID,
					})
				: defaults(request, all),
		);
		const node = s2dMapped({ 'Client name': '={{ $json.n }}', 'Old column': '={{ $json.n }}' }, { unknownKeys: 'drop' });

		const result = await mapColumns(api, [{ json: { n: 'A' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'A', 'Old column': 'A' }]);
		expect(api.gets()).toHaveLength(1);
		const error = result.errorOf('SourceToDocs') as unknown as { name: string; message: string; description: string };
		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('Unknown columns.');
		expect(error.description).toContain('inline_column_unknown');
	});

	it('B: a column the schema marks removed is not sent, even when it is mapped', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', Owner: '={{ $json.owner }}' });

		await mapColumns(api, [{ json: { name: 'A', owner: 'rec123' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'A' }]);
	});
});

describe('Map Columns, Map Automatically', () => {
	const items = [
		{ json: { 'Client name': 'Acme', id: 'rec1', createdTime: 't1' } },
		{ json: { 'Client name': 'Globex', submittedAt: 's2' } },
	];

	it('sends every item its own fields, Unknown Fields dropping what is not a column, and reports it', async () => {
		const api = await startApi();

		const result = await mapColumns(api, items, s2dMapped(null, { unknownKeys: 'drop' }, 'autoMapInputData'));

		expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`GET ${API_PATH}/documents/${DOC_ID}`,
			`POST ${API_PATH}/documents/${DOC_ID}/runs`,
		]);
		expect(sentRows(api)).toEqual([{ 'Client name': 'Acme' }, { 'Client name': 'Globex' }]);
		const dropped = result.json('SourceToDocs')[0].dropped_keys as Record<string, string[]>;
		expect([...dropped[DS_ID]].sort()).toEqual(['createdTime', 'id', 'submittedAt']);
	});

	it('Refuse sends the fields exactly as given and reads the document only for the split key', async () => {
		const api = await startApi();

		const result = await mapColumns(api, items, s2dMapped(null, { unknownKeys: 'refuse' }, 'autoMapInputData'));

		expect(api.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
		expect(sentRows(api)).toEqual(items.map((item) => item.json));
		expect(result.json('SourceToDocs')[0].dropped_keys).toBeUndefined();
	});

	it('Drop lists __proto__, constructor and id, and pollutes nothing', async () => {
		const api = await startApi();
		const hostile =
			'[{"json":{"Client name":"A","__proto__":{"polluted":true},"constructor":"c","id":"rec1"}}]';

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [{ name: 'Emit', type: 'test.emit', parameters: { items: hostile } }, s2dMapped(null, {}, 'autoMapInputData')],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(sentRows(api)).toEqual([{ 'Client name': 'A' }]);
		const dropped = result.json('SourceToDocs')[0].dropped_keys as Record<string, string[]>;
		expect([...dropped[DS_ID]].sort()).toEqual(['__proto__', 'constructor', 'id']);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe('Map Columns, Additional Data Sets', () => {
	const row = [{ json: { name: 'Acme' } }];

	it('merges the additional Data Sets beside the mapped one', async () => {
		const api = await startApi();
		const node = s2dMapped(
			{ 'Client name': '={{ $json.name }}' },
			{ unknownKeys: 'drop', additionalDataSets: { values: [{ dataSetId: DS2_ID, rows: '[{"Sku":"X1","junk":1}]' }] } },
		);

		const result = await mapColumns(api, row, node);

		expect(bodyOf(api.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ 'Client name': 'Acme' }], [DS2_ID]: [{ Sku: 'X1' }] },
		});
		expect(result.json('SourceToDocs')[0].dropped_keys).toEqual({ [DS2_ID]: ['junk'] });
	});

	it('drops only the Additional Data Sets rows: manual rows go as mapped', async () => {
		const api = await startApi();
		const node = s2dMapped(
			{ 'Client name': '={{ $json.name }}', 'Added later': 'kept' },
			{ unknownKeys: 'drop', additionalDataSets: { values: [{ dataSetId: DS2_ID, rows: '[{"Sku":"X1","junk":1}]' }] } },
		);

		const result = await mapColumns(api, row, node);

		expect(bodyOf(api.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ 'Client name': 'Acme', 'Added later': 'kept' }], [DS2_ID]: [{ Sku: 'X1' }] },
		});
		expect(result.json('SourceToDocs')[0].dropped_keys).toEqual({ [DS2_ID]: ['junk'] });
	});

	it('parses a JSON string of rows the way the Data Sets collection does', async () => {
		const api = await startApi();
		const node = s2dMapped(
			{ 'Client name': '={{ $json.name }}' },
			{ unknownKeys: 'refuse', additionalDataSets: { values: [{ dataSetId: DS2_ID, rows: '[{"Sku":"X1"}]' }] } },
		);

		await mapColumns(api, row, node);

		expect(sentRows(api, DS2_ID)).toEqual([{ Sku: 'X1' }]);
	});

	it('refuses, before any request and naming it, the mapped Data Set listed again', async () => {
		const api = await startApi();
		const node = s2dMapped(
			{ 'Client name': '={{ $json.name }}' },
			{ additionalDataSets: { values: [{ dataSetId: DS_ID, rows: '[]' }] } },
		);

		const result = await mapColumns(api, row, node);

		expect(result.errorOf('SourceToDocs')?.message).toMatch(new RegExp(`${DS_ID}.*Additional Data Sets`));
		expect(api.requests).toEqual([]);
	});

	it('names Additional Data Sets, not Data Sets, in an entry error', async () => {
		const api = await startApi();
		const node = s2dMapped(
			{ 'Client name': '={{ $json.name }}' },
			{ additionalDataSets: { values: [{ dataSetId: DS2_ID, rows: 'nope' }] } },
		);

		const result = await mapColumns(api, row, node);

		expect(result.errorOf('SourceToDocs')?.message).toMatch(/in 'Additional Data Sets'/);
		expect(api.requests).toEqual([]);
	});
});

describe('Map Columns reports what was empty', () => {
	const emptyColumnsHint = (hints: Array<{ message: string }>) => hints.filter((hint) => /had no value/.test(hint.message));

	it('a list field read like an object is sent, listed in empty_columns and hinted', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.clients.name }}', Amount: '={{ $json.amount }}' });

		const result = await mapColumns(api, [{ json: { clients: [{ name: 'x' }], amount: 5 } }], node);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(sentRows(api)).toEqual([{ Amount: 5 }]);
		expect(result.json('SourceToDocs')[0].empty_columns).toEqual(['Client name', 'Due', 'Paid']);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_rows');
		const hints = emptyColumnsHint(result.hintsOf('SourceToDocs'));
		expect(hints).toHaveLength(1);
		expect(hints[0].message).toContain("'Client name'");
		expect(hints[0].message).toMatch(/Split Out/);
		expect(hints[0].message).toMatch(/\.map\(/);
	});

	it('the list itself and .map(...) go as JSON and report nothing', async () => {
		const api = await startApi();
		const node = s2dMapped({
			'Client name': '={{ $json.clients }}',
			Amount: '={{ $json.clients.map(c => c.name) }}',
			Due: '2026-01-01',
			Paid: true,
		});

		const result = await mapColumns(api, [{ json: { clients: [{ name: 'x' }] } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': [{ name: 'x' }], Amount: ['x'], Due: '2026-01-01', Paid: true }]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_columns');
		expect(result.hintsOf('SourceToDocs')).toEqual([]);
	});

	it('a column empty in 1 of 3 items is not reported', async () => {
		const api = await startApi();
		const node = s2dMapped({ 'Client name': '={{ $json.name }}', ...otherShown });

		const result = await mapColumns(api, [{ json: { name: 'A' } }, { json: {} }, { json: { name: 'C' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'A', ...otherShown }, { ...otherShown }, { 'Client name': 'C', ...otherShown }]);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_columns');
		// No row is blank: the other columns carry values.
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_rows');
		expect(emptyColumnsHint(result.hintsOf('SourceToDocs'))).toEqual([]);
	});

	it('null columns are sent as null and reported, and so are the undefined ones', async () => {
		const api = await startApi();
		const node = s2dMapped({
			'Client name': '={{ $json.name }}',
			Amount: null,
			Due: '={{ $json.missing }}',
			Paid: '={{ null }}',
		});

		const result = await mapColumns(api, [{ json: { name: 'A' } }, { json: { name: 'B' } }], node);

		expect(sentRows(api)).toEqual([
			{ 'Client name': 'A', Amount: null, Paid: null },
			{ 'Client name': 'B', Amount: null, Paid: null },
		]);
		expect(result.json('SourceToDocs')[0].empty_columns).toEqual(['Amount', 'Due', 'Paid']);
		const hints = emptyColumnsHint(result.hintsOf('SourceToDocs'));
		expect(hints).toHaveLength(1);
		expect(hints[0].message).toContain("'Amount', 'Due', 'Paid'");
	});

	it('an untouched number column and boolean column send no key and are reported, like any empty column', async () => {
		const api = await startApi();
		// What the editor stores for a column nobody touched: no key at all (a `string` field, see resourceMapping.ts).
		const node = s2dMapped({ 'Client name': '={{ $json.name }}' });

		const result = await mapColumns(api, [{ json: { name: 'A' } }, { json: { name: 'B' } }], node);

		expect(sentRows(api)).toEqual([{ 'Client name': 'A' }, { 'Client name': 'B' }]);
		expect(result.json('SourceToDocs')[0].empty_columns).toEqual(['Amount', 'Due', 'Paid']);
		expect(emptyColumnsHint(result.hintsOf('SourceToDocs'))[0].message).toContain("'Amount', 'Due', 'Paid'");
	});

	it('a column hidden in the add-column list is never reported', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { name: 'A' } }], s2dMapped({ 'Client name': '={{ $json.name }}', ...otherShown, Owner: null }));

		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_columns');
	});

	it('rows that are {} are sent, counted in empty_rows and hinted: Map Automatically', async () => {
		const api = await startApi();
		const items = [{ json: { 'Client name': 'A' } }, { json: {}, binary: {} }, { json: {} }];

		const result = await mapColumns(api, items, s2dMapped(null, { unknownKeys: 'refuse' }, 'autoMapInputData'));

		expect(sentRows(api)).toEqual([{ 'Client name': 'A' }, {}, {}]);
		expect(result.json('SourceToDocs')[0].empty_rows).toBe(2);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_columns');
		const hints = result.hintsOf('SourceToDocs');
		expect(hints).toHaveLength(1);
		expect(hints[0].message).toMatch(/^2 row\(s\) had no fields/);
	});

	it('Map Automatically with nothing but blank rows is sent too (the guard is for manual mapping)', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: {} }, { json: {} }], s2dMapped(null, { unknownKeys: 'refuse' }, 'autoMapInputData'));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(sentRows(api)).toEqual([{}, {}]);
		expect(result.json('SourceToDocs')[0].empty_rows).toBe(2);
	});

	it('a binary-only item in Map Columns is counted among the empty rows', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { name: 'A' } }, { json: {} }], s2dMapped({ 'Client name': '={{ $json.name }}' }));

		expect(result.json('SourceToDocs')[0].empty_rows).toBe(1);
	});

	it('a Map Columns run with no empty column or row carries neither field nor hint', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { name: 'A' } }], s2dMapped({ 'Client name': '={{ $json.name }}', ...otherShown }));

		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_columns');
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('empty_rows');
		expect(result.hintsOf('SourceToDocs')).toEqual([]);
	});
});

describe('Map Columns with Execute Once', () => {
	it('sends only the first item and says so in a hint', async () => {
		const api = await startApi();
		const items = [{ json: { n: 'A' } }, { json: { n: 'B' } }, { json: { n: 'C' } }];

		const result = await mapColumns(api, items, { ...s2dMapped({ 'Client name': '={{ $json.n }}', ...otherShown }), executeOnce: true });

		expect(sentRows(api)).toEqual([{ 'Client name': 'A', ...otherShown }]);
		const hints = result.hintsOf('SourceToDocs');
		expect(hints).toHaveLength(1);
		expect(hints[0].message).toMatch(/'Execute Once' is on.*only the first input item/);
		expect(hints[0].message).toMatch(/'Rows Come From' to JSON/);
	});

	it('adds no such hint without Execute Once', async () => {
		const api = await startApi();

		const result = await mapColumns(api, [{ json: { n: 'A' } }], s2dMapped({ 'Client name': '={{ $json.n }}', ...otherShown }));

		expect(result.hintsOf('SourceToDocs')).toEqual([]);
	});
});

describe('Unknown Fields: Drop against a Data Set with no listed columns', () => {
	const noColumns = () => {
		const defaults = defaultRouter();
		return (request: RecordedRequest, all: RecordedRequest[]) => {
			const reply = defaults(request, all);
			if (request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`) {
				const data = structuredClone(reply.body) as { data: { document: { data_sets: Array<{ id: string; columns: unknown[] }> } } };
				data.data.document.data_sets.find((dataSet) => dataSet.id === DS_ID)!.columns = [];
				return { ...reply, body: data };
			}
			return reply;
		};
	};

	it('Map Automatically sends the rows untouched and reports nothing dropped', async () => {
		const api = await startApi(noColumns());

		const result = await mapColumns(api, [{ json: { 'Client name': 'A', id: 'rec1' } }], s2dMapped(null, { unknownKeys: 'drop' }, 'autoMapInputData'));

		expect(api.gets()).toHaveLength(1);
		expect(sentRows(api)).toEqual([{ 'Client name': 'A', id: 'rec1' }]);
		expect(result.json('SourceToDocs')[0].dropped_keys).toEqual({});
	});

	it('a JSON entry is left untouched too', async () => {
		const api = await startApi(noColumns());
		const json = s2dJson([{ dataSetId: DS_ID, rows: '[{"a":1}]' }], { unknownKeys: 'drop' });

		const result = await mapColumns(api, [{ json: {} }], json);

		expect(sentRows(api)).toEqual([{ a: 1 }]);
		expect(result.json('SourceToDocs')[0].dropped_keys).toEqual({});
	});
});

describe('Map Columns names a split key it leaves unmapped', () => {
	const splitHint = (hints: Array<{ message: string }>) => hints.filter((hint) => /A row without a key/.test(hint.message));
	const keyed = { 'Client name': '={{ $json.name }}', ...otherShown };

	it('a key column no node mapped is reported in the output and the hint, and the run is still sent', async () => {
		const api = await startApi(documentRouter(splitOn(['Client name'])));
		// Client name is a shown column the editor stored no value for: an untouched key.
		const node = s2dMapped({ ...otherShown });

		const result = await mapColumns(api, [{ json: { name: 'A' } }], node);

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
		expect(sentRows(api)).toEqual([{ ...otherShown }]);
		expect(result.json('SourceToDocs')[0].missing_split_keys).toEqual(['Client name']);
		const hints = splitHint(result.hintsOf('SourceToDocs'));
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({ type: 'warning', location: 'outputPane' });
		expect(hints[0].message).toContain("'Client name'");
		expect(hints[0].message).toMatch(/no file/);
	});

	it('a key column hidden in the add-column list is reported too', async () => {
		const api = await startApi(documentRouter(splitOn(['Owner'])));

		const result = await mapColumns(api, [{ json: { name: 'A' } }], s2dMapped({ Owner: null, ...keyed }));

		expect(sentRows(api)).toEqual([{ 'Client name': 'A', ...otherShown }]);
		expect(result.json('SourceToDocs')[0].missing_split_keys).toEqual(['Owner']);
	});

	it('a key column mapped to nothing, or to a blank, in every item is reported, each column named', async () => {
		const api = await startApi(documentRouter(splitOn(['Client name', 'Due'])));
		const node = s2dMapped({ 'Client name': '={{ $json.missing }}', Amount: 1, Due: '={{ "" }}', Paid: true });

		const result = await mapColumns(api, [{ json: {} }, { json: {} }], node);

		expect(result.json('SourceToDocs')[0].missing_split_keys).toEqual(['Client name', 'Due']);
		expect(splitHint(result.hintsOf('SourceToDocs'))[0].message).toContain("'Client name', 'Due'");
	});

	it('Map Automatically reports a key no item carries', async () => {
		const api = await startApi(documentRouter(splitOn(['Client name'])));

		const result = await mapColumns(api, [{ json: { Amount: 1 } }, { json: { Amount: 2 } }], s2dMapped(null, {}, 'autoMapInputData'));

		expect(result.json('SourceToDocs')[0].missing_split_keys).toEqual(['Client name']);
	});

	it('a key filled in at least one item gives neither the field nor the hint', async () => {
		const api = await startApi(documentRouter(splitOn(['Client name'])));

		const result = await mapColumns(api, [{ json: {} }, { json: { name: 'B' } }], s2dMapped(keyed));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('missing_split_keys');
		expect(splitHint(result.hintsOf('SourceToDocs'))).toEqual([]);
	});

	it.each([
		['the key is unpublished (null)', { split: { enabled: true, driver_data_source_id: 's', driver_source_table_id: 't', key: null } }],
		['an older API sends no key field', { split: { enabled: true, driver_data_source_id: 's', driver_source_table_id: 't' } }],
		['the document is not split', { split: null }],
		['the split is switched off', splitOn(['Client name'], DS_ID, false)],
		['the key belongs to another Data Set', splitOn(['Sku'], DS2_ID)],
		['the key lists no column', splitOn([])],
	])('no check when %s', async (_name, overrides) => {
		const api = await startApi(documentRouter(overrides));

		const result = await mapColumns(api, [{ json: { name: 'A' } }], s2dMapped({ ...otherShown }));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).not.toHaveProperty('missing_split_keys');
		expect(splitHint(result.hintsOf('SourceToDocs'))).toEqual([]);
	});

	it('reads the document once when Unknown Fields: Drop reads it too', async () => {
		const api = await startApi(documentRouter(splitOn(['Client name'])));

		const result = await mapColumns(api, [{ json: { Amount: 1 } }], s2dMapped(null, { unknownKeys: 'drop' }, 'autoMapInputData'));

		expect(api.gets()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0].missing_split_keys).toEqual(['Client name']);
	});
});

describe('Map Columns with an options column: the list is offered, never enforced', () => {
	const stage = { id: 'Stage', displayName: 'Stage', required: false, defaultMatch: false, display: true, type: 'options', canBeUsedToMatch: false, removed: false, options: [{ name: 'Open', value: 'Open' }, { name: 'Won', value: 'Won' }] };
	const withStage = (value: Record<string, unknown>) => {
		const node = s2dMapped(value);
		(node.parameters as { columns: { schema: unknown[] } }).columns.schema = [stage];
		return node;
	};

	it('a value in the list and an expression, whatever it resolves to, go as they come, in one POST', async () => {
		for (const [stageValue, expected] of [
			['Won', 'Won'],
			['={{ $json.stage }}', 'Lost'],
			['={{ "" }}', ''],
		] as const) {
			const api = await startApi();

			const result = await mapColumns(api, [{ json: { stage: 'Lost' } }], withStage({ Stage: stageValue }));

			expect(result.errorOf('SourceToDocs')).toBeUndefined();
			expect(api.posts()).toHaveLength(1);
			expect(sentRows(api)).toEqual([{ Stage: expected }]);
		}
	});

	it('a literal outside the list is refused by n8n before the run (measured: skipValidation does not reach this check)', async () => {
		const api = await startApi();

		await expect(mapColumns(api, [{ json: {} }], withStage({ Stage: 'Maybe' }))).rejects.toThrow(/Stage.*expects one of the following values/);
		expect(api.requests).toEqual([]);
	});
});
