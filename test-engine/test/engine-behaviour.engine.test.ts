/**
 * What only the real engine decides, around the SourceToDocs node: the credential on the wire,
 * a refused connection, zero items, Execute Once, the node executing twice, and what a node
 * downstream can read through `.item`.
 */
import { describe, expect, it } from 'vitest';

import {
	DOC_ID,
	DS_ID,
	TOKEN,
	capture,
	defaultRouter,
	emit,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	s2dJson,
	otherShown,
	s2dMapped,
	bodyOf,
	useFakeApis,
	type Router,
} from './harness';

const startApi = useFakeApis();

const projectsRouter: Router = () => ok({ projects: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Marketing', timezone: null }] });
const projectGetMany = () => s2d({ resource: 'project', operation: 'getMany' });

describe('The credential and the connection', () => {
	it('the token goes on the wire as a bearer header and is in no run data', async () => {
		const api = await startApi(projectsRouter);

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), projectGetMany()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.requests).toHaveLength(1);
		expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(JSON.stringify(result.run.data)).not.toContain(TOKEN);
	});

	it('a refused connection is a NodeApiError, and the token is in no run data', async () => {
		const result = await runWorkflow({
			baseUrl: 'http://127.0.0.1:9/api/public/v1',
			nodes: [emit([{ json: {} }]), projectGetMany()],
			connections: [['Emit', 'SourceToDocs']],
		});

		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeApiError');
		expect(error?.message).toMatch(/refused the connection/);
		expect(JSON.stringify(result.run.data)).not.toContain(TOKEN);
	});
});

describe('Items reaching the node', () => {
	const rowsFromItems = () => s2dJson([{ dataSetId: DS_ID, rows: '={{ $input.all().map(i => i.json) }}' }], { unknownKeys: 'refuse' });

	it('zero input items: the node does not run, and nothing is sent', async () => {
		const api = await startApi();

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([]), rowsFromItems()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.order).toEqual(['Emit']);
		expect(result.out).not.toHaveProperty('SourceToDocs');
		expect(api.requests).toEqual([]);
	});

	it('with Always Output Data on the node before it, the node runs once on an empty item', async () => {
		const api = await startApi();

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [{ ...emit([]), alwaysOutputData: true }, rowsFromItems()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.order).toEqual(['Emit', 'SourceToDocs']);
		expect(api.posts()).toHaveLength(1);
		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{}] } });
		expect(result.json('SourceToDocs')).toHaveLength(1);
		// The one blank row is counted and hinted.
		expect(result.json('SourceToDocs')[0].empty_rows).toBe(1);
		expect(result.hintsOf('SourceToDocs')).toHaveLength(1);
		expect(result.hintsOf('SourceToDocs')[0].message).toMatch(/^1 row\(s\) had no fields/);
	});

	it('JSON mode: a binary-only item is a blank row, sent, counted and hinted', async () => {
		const api = await startApi();

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: { 'Client name': 'A' } }, { json: {}, binary: {} }]), rowsFromItems()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ 'Client name': 'A' }, {}] } });
		expect(result.json('SourceToDocs')[0].empty_rows).toBe(1);
		expect(result.hintsOf('SourceToDocs')).toHaveLength(1);
	});

	it('Execute Once: JSON mode still sends every parent item, Map Columns only the first', async () => {
		const items = [{ json: { 'Client name': 'A' } }, { json: { 'Client name': 'B' } }, { json: { 'Client name': 'C' } }];

		const jsonApi = await startApi();
		const jsonResult = await runWorkflow({
			baseUrl: jsonApi.baseUrl,
			nodes: [emit(items), { ...rowsFromItems(), executeOnce: true }],
			connections: [['Emit', 'SourceToDocs']],
		});
		const mappedApi = await startApi();
		const mappedResult = await runWorkflow({
			baseUrl: mappedApi.baseUrl,
			nodes: [emit(items), { ...s2dMapped({ 'Client name': '={{ $json["Client name"] }}', ...otherShown }), executeOnce: true }],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(jsonApi.posts()).toHaveLength(1);
		expect(bodyOf(jsonApi.posts()[0])).toEqual({
			inline_data: { [DS_ID]: [{ 'Client name': 'A' }, { 'Client name': 'B' }, { 'Client name': 'C' }] },
		});
		expect(mappedApi.posts()).toHaveLength(1);
		expect(bodyOf(mappedApi.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ 'Client name': 'A', ...otherShown }] } });
		// Map Columns says so; JSON mode sends every row and has nothing to say.
		expect(jsonResult.hintsOf('SourceToDocs')).toEqual([]);
		expect(mappedResult.hintsOf('SourceToDocs')).toHaveLength(1);
		expect(mappedResult.hintsOf('SourceToDocs')[0].message).toMatch(/'Execute Once' is on.*only the first input item/);
	});
});

describe('The node executing twice in one workflow', () => {
	it('runs once per branch: [A1, A2] then [B1], and downstream .item resolves at runIndex 0 and 1', async () => {
		let created = 0;
		const defaults = defaultRouter({ status: 'succeeded' });
		const api = await startApi((request, all) =>
			request.method === 'POST' ? ok({ run: runPayload({ id: `b0000000-0000-4000-8000-00000000000${++created}`, status: 'succeeded' }) }, 201) : defaults(request, all),
		);

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			start: 'Trigger',
			nodes: [
				emit([{ json: {} }], 'Trigger'),
				emit([{ json: { 'Client name': 'A1' } }, { json: { 'Client name': 'A2' } }], 'A'),
				emit([{ json: { 'Client name': 'B1' } }], 'B'),
				s2dMapped({ 'Client name': '={{ $json["Client name"] }}' }),
				capture("={{ $('SourceToDocs').item.json.run_id }} {{ $runIndex }}"),
			],
			connections: [['Trigger', 'A'], ['Trigger', 'B'], ['A', 'SourceToDocs'], ['B', 'SourceToDocs'], ['SourceToDocs', 'Capture']],
		});

		expect(result.errorOf('SourceToDocs', 0)).toBeUndefined();
		expect(result.errorOf('SourceToDocs', 1)).toBeUndefined();
		expect(api.posts().map((p) => (p.body as { inline_data: Record<string, unknown> }).inline_data[DS_ID])).toEqual([
			[{ 'Client name': 'A1' }, { 'Client name': 'A2' }],
			[{ 'Client name': 'B1' }],
		]);
		expect(result.out.SourceToDocs).toHaveLength(2);
		expect(result.json('Capture', 0)).toEqual([{ value: 'b0000000-0000-4000-8000-000000000001 0' }]);
		expect(result.json('Capture', 1)).toEqual([{ value: 'b0000000-0000-4000-8000-000000000002 1' }]);
	});
});

describe('Reading the node from downstream', () => {
	const lookups = [
		capture("={{ $('Emit').item.json['Client name'] }}", 'FromEmit'),
		capture("={{ $('SourceToDocs').item.json.run_id }}", 'FromSourceToDocs'),
	];

	const run = async (count: number, downstream: string) => {
		const api = await startApi(defaultRouter({ status: 'succeeded' }));
		const items = Array.from({ length: count }, (_, i) => ({ json: { 'Client name': `C${i}` } }));
		return await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit(items), s2dConnected(), ...lookups.filter((node) => node.name === downstream)],
			connections: [['Emit', 'SourceToDocs'], ['SourceToDocs', downstream]],
		});
	};

	it('with 1 input item both lookups resolve', async () => {
		const fromEmit = await run(1, 'FromEmit');
		const fromNode = await run(1, 'FromSourceToDocs');

		expect(fromEmit.json('FromEmit')).toEqual([{ value: 'C0' }]);
		expect(fromNode.json('FromSourceToDocs')).toEqual([{ value: 'b0000000-0000-4000-8000-000000000001' }]);
	});

	it("with 3 input items $('Emit').item throws \"Multiple matches found\" but $('SourceToDocs').item resolves", async () => {
		const fromEmit = await run(3, 'FromEmit');
		const fromNode = await run(3, 'FromSourceToDocs');

		expect(fromEmit.errorOf('FromEmit')?.message).toMatch(/Multiple matches found/);
		expect(fromNode.errorOf('FromSourceToDocs')).toBeUndefined();
		expect(fromNode.json('FromSourceToDocs')).toEqual([{ value: 'b0000000-0000-4000-8000-000000000001' }]);
	});
});

describe('Generate reads its parameters from the first item', () => {
	const DOC_B = '9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e7';

	it('a Document or Idempotency Key expression takes item 0 for the whole run; Map Columns cells read their own item', async () => {
		const api = await startApi();

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [
				emit([
					{ json: { doc: DOC_ID, key: 'key-a', name: 'A' } },
					{ json: { doc: DOC_B, key: 'key-b', name: 'B' } },
				]),
				s2dMapped(
					{ 'Client name': '={{ $json.name }}', ...otherShown },
					{
						documentId: { __rl: true, mode: 'id', value: '={{ $json.doc }}' },
						idempotencyKey: '={{ $json.key }}',
					},
				),
			],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
		expect(api.posts()[0].path).toBe(`/api/public/v1/documents/${DOC_ID}/runs`);
		expect(api.posts()[0].body).toMatchObject({ idempotency_key: 'key-a' });
		expect(bodyOf(api.posts()[0])).toMatchObject({
			inline_data: { [DS_ID]: [{ 'Client name': 'A' }, { 'Client name': 'B' }] },
		});
	});
});
