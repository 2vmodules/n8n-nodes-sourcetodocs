/**
 * The least-reached paths of the node, covered on the real engine:
 * a JSON body without a boolean `success`; JSON mode with every Data Set entry removed; a failed
 * run or batch with null codes, and a failed batch with no failed children; a non-node error
 * through `asNodeError`.
 *
 * The `Retry-After` variants are in `transport.engine.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
	DOC_ID,
	DS_ID,
	API_PATH,
	defaultRouter,
	emit,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	s2dJson,
	bodyOf,
	useFakeApis,
	type FakeApi,
	type Router,
	type TestNode,
} from './harness';

const RUN_ERROR_CODES = 'https://app.sourcetodocs.com/docs/reference/run-error-codes/';
const TROUBLESHOOTING = 'https://app.sourcetodocs.com/docs/guides/troubleshooting/';

const startApi = useFakeApis();

interface ErrorCopy {
	name: string;
	message: string;
	description?: string;
	context: Record<string, unknown>;
}

const waiting = { waitForCompletion: true, maxWait: 300, pollEvery: 5 };
const continueOn = { onError: 'continueRegularOutput' as const };

async function generate(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

describe('a JSON body without a boolean success', () => {
	it.each([
		['a wrong Base URL that answers JSON (200, data only)', 200, { data: { projects: [] } }],
		['a proxy JSON error (502)', 502, { error: 'upstream timed out' }],
		['a success that is a string', 200, { success: 'true', data: { projects: [] } }],
		['an array', 200, []],
		['null', 200, null],
	])('%s is not an envelope', async (_title, status, body) => {
		const api = await startApi(() => ({ status, body }));

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), s2d({ resource: 'project', operation: 'getMany' })],
			connections: [['Emit', 'SourceToDocs']],
		});

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe(
			status === 502
				? 'The SourceToDocs API answered HTTP 502: the API is unreachable'
				: 'The SourceToDocs API answered HTTP 200 without its JSON envelope',
		);
		expect(result.items('SourceToDocs')).toHaveLength(0);
	});

	it('on the start POST of Generate stops the node before any run is read', async () => {
		const api = await startApi(() => ({ status: 201, body: { data: { run: runPayload() } } }));

		const result = await generate(api, s2dConnected(waiting));

		expect((result.errorOf('SourceToDocs') as unknown as ErrorCopy).message).toContain('without its JSON envelope');
		expect(api.requests).toHaveLength(1);
	});
});

describe('JSON mode with every Data Set entry removed', () => {
	it('sends inline_data as an empty object (Unknown Fields: Drop still reads the document once)', async () => {
		const api = await startApi(defaultRouter());

		const result = await generate(api, s2dJson([]));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(api.posts()).toHaveLength(1);
		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: {} });
		expect(api.gets().map((r) => r.path)).toEqual([`${API_PATH}/documents/${DOC_ID}`]);
	});

	it('sends an empty rows list for an entry whose Rows is an empty array', async () => {
		const api = await startApi(defaultRouter());

		await generate(api, s2dJson([{ dataSetId: DS_ID, rows: '[]' }]));

		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [] } });
	});
});

describe('a failed run with null codes', () => {
	const failedSingle = (overrides: Record<string, unknown>) => defaultRouter({ status: 'failed', ...overrides });

	it('with no message and no code is "The run ended before the document was produced", naming only the run id', async () => {
		const api = await startApi(failedSingle({ error_message: null, error_code: null }));

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toBe('The run ended before the document was produced');
		expect(error.description).toBe(`The run ended without a code. See ${RUN_ERROR_CODES} for the codes a run can end with, then run the document again. Run ID: b0000000-0000-4000-8000-000000000001`);
		expect(error.context.errorCode).toBeNull();
		expect(error.context.runId).toBe('b0000000-0000-4000-8000-000000000001');
	});

	it('with a code but no message keeps the code in the description', async () => {
		const api = await startApi(failedSingle({ error_message: null, error_code: 'render_failed' }));

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.message).toBe('The run ended before the document was produced');
		expect(error.description).toBe(`Code: render_failed. See ${TROUBLESHOOTING}#render_failed for what this code means and how to fix it, then run the document again. Run ID: b0000000-0000-4000-8000-000000000001`);
	});

	it('with Continue On Fail is one item carrying the message and the run id, and no error_code', async () => {
		const api = await startApi(failedSingle({ error_message: null, error_code: null }));

		const result = await generate(api, s2dConnected(waiting, continueOn));

		expect(result.json('SourceToDocs')).toEqual([{ error: 'The run ended before the document was produced', run_id: 'b0000000-0000-4000-8000-000000000001' }]);
	});
});

describe('a failed batch with null codes or no failed children', () => {
	const batchRouter = (children: unknown[], batch: Record<string, unknown> = {}): Router =>
		(request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed', ...batch }) }, 201)
				: ok({ runs: children });

	it('names children with no code as "no code", and a batch with no message as "The batch run ended before all of its documents were produced"', async () => {
		const children = [
			runPayload({ id: 'child-1', status: 'failed', error_code: null }),
			runPayload({ id: 'child-2', status: 'failed', error_code: null }),
		];
		const api = await startApi(batchRouter(children, { error_message: null, error_code: null }));

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.message).toBe('The batch run ended before all of its documents were produced');
		expect(error.description).toContain('child-1 (no code)');
		expect(error.description).toContain('child-2 (no code)');
		expect(error.context.errorCode).toBeNull();
		expect((error.context.failedChildren as Array<{ error_code: unknown }>).map((c) => c.error_code)).toEqual([null, null]);
	});

	it('with Continue On Fail gives one item per failed child, with a null error_code left as null', async () => {
		const children = [runPayload({ id: 'child-1', status: 'failed', error_code: null, error_message: null })];
		const api = await startApi(batchRouter(children));

		const result = await generate(api, s2dConnected(waiting, continueOn));

		const items = result.json('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ run_id: 'child-1', batch_run_id: 'c0000000-0000-4000-8000-000000000001', error_code: null, error_message: null });
	});

	it.each([
		['the children list is empty', []],
		['every child succeeded', [runPayload({ id: 'child-1', status: 'succeeded' })]],
	])('when %s, says only the batch id', async (_title, children) => {
		const api = await startApi(batchRouter(children, { error_message: 'The batch failed.', error_code: 'batch_failed' }));

		const result = await generate(api, s2dConnected(waiting));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.message).toBe('The batch failed.');
		expect(error.description).toBe(`Batch run ID: c0000000-0000-4000-8000-000000000001. See batch_failed: ${TROUBLESHOOTING}#batch_failed for what each code means and how to fix it, then run the document again. Run ID: c0000000-0000-4000-8000-000000000001`);
		expect(error.context.failedChildren).toEqual([]);
	});

	it('with Continue On Fail and no failed children is one item for the batch, with its code', async () => {
		const api = await startApi(batchRouter([], { error_message: 'The batch failed.', error_code: 'batch_failed' }));

		const result = await generate(api, s2dConnected(waiting, continueOn));

		expect(result.json('SourceToDocs')).toEqual([
			{ error: 'The batch failed.', error_code: 'batch_failed', run_id: 'c0000000-0000-4000-8000-000000000001' },
		]);
	});
});

describe('a non-node error through asNodeError', () => {
	// Emit (2 items) -> Generate (one item paired to both) -> Generate whose Rows expression
	// names `$('Emit').item`: that item has two matches, so n8n's expression engine throws.
	const chain = (api: FakeApi, extra: Record<string, unknown> = {}) =>
		runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [
				emit([{ json: { id: 'a' } }, { json: { id: 'b' } }]),
				s2dConnected(),
				s2dJson([{ dataSetId: DS_ID, rows: "={{ [$('Emit').item.json] }}" }], {}, { name: 'Second', ...extra }),
			],
			connections: [
				['Emit', 'SourceToDocs'],
				['SourceToDocs', 'Second'],
			],
		});

	it('is wrapped into a NodeOperationError that keeps the expression message', async () => {
		const api = await startApi(defaultRouter());

		const result = await chain(api);

		const error = result.errorOf('Second') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toMatch(/Multiple matches found/);
		expect(api.posts()).toHaveLength(1);
	});

	it('with Continue On Fail becomes one error item paired to the input item', async () => {
		const api = await startApi(defaultRouter());

		const result = await chain(api, continueOn);

		const items = result.items('Second');
		expect(items).toHaveLength(1);
		expect(String(items[0].json.error)).toMatch(/Multiple matches found/);
		expect(items[0].json).not.toHaveProperty('error_code');
		expect(items[0].pairedItem).toEqual([{ item: 0 }]);
	});
});
