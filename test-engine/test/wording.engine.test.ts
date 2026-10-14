/**
 * What a person reads when the node stops (n8n's UX guidelines, `ux-guidelines.md`): every
 * message and description, from every path that needs n8n's engine to be reached, names the
 * parameter in single quotes, says how to get unstuck, and avoids "error", "failed", "failure"
 * and "problem". The paths that are plain functions are in test/wording.test.ts.
 *
 * n8n appends `[item N]` to a message from `context.itemIndex`, counting from 0.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DS_ID,
	bodyOf,
	defaultRouter,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	s2dJson,
	s2dMapped,
	useFakeApis,
	type FakeApi,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

interface ErrorCopy {
	name: string;
	message: string;
	description?: string;
	context: Record<string, unknown>;
}

const AVOIDED = /\b(errors?|fail(?:s|ed|ing|ures?)?|problems?)\b/i;
const NEXT_STEP = /https:\/\/app\.sourcetodocs\.com\/docs\/|'[A-Z][^']*'|[Tt]ry again|Correct the fields/;
const prose = (text: string) => text.replace(/https?:\/\/\S+/g, '').replace(/\b\w+_\w+\b/g, '');

async function run(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({ baseUrl: api.baseUrl, nodes: [emit(items), node], connections: [['Emit', node.name]] });
}

function expectWording(error: ErrorCopy | undefined): ErrorCopy {
	if (error === undefined) throw new Error('the node did not stop');
	expect(prose(error.message), `message: ${error.message}`).not.toMatch(AVOIDED);
	expect(error.description, `no description for: ${error.message}`).toBeTruthy();
	expect(prose(error.description as string), `description: ${error.description}`).not.toMatch(AVOIDED);
	expect(error.description as string, `no next step in: ${error.description}`).toMatch(NEXT_STEP);
	return error;
}

const errorOf = (result: Awaited<ReturnType<typeof run>>) => result.errorOf('SourceToDocs') as unknown as ErrorCopy | undefined;
const waiting = { waitForCompletion: true, maxWait: 300, pollEvery: 5 };

describe('the words of each way Generate stops', () => {
	const batch = (children: unknown[], overrides: Record<string, unknown> = {}): Router => (request) =>
		request.method === 'POST'
			? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed', ...overrides }) }, 201)
			: ok({ runs: children });

	const GUIDE = 'https://app.sourcetodocs.com/docs/guides/troubleshooting/';
	const REFERENCE = 'https://app.sourcetodocs.com/docs/reference/run-error-codes/';

	it.each([
		['a run that ended with a code', defaultRouter({ status: 'failed', error_code: 'render_failed', error_message: 'The template could not be rendered.' }), [`${GUIDE}#render_failed`]],
		['a run that ended with a split code', defaultRouter({ status: 'failed', error_code: 'split_driver_rows_missing', error_message: 'No rows.' }), [`${GUIDE}#split_driver_rows_missing`]],
		['a run that ended with no code and no message', defaultRouter({ status: 'failed', error_code: null, error_message: null }), [REFERENCE]],
		['a batch with failed files', batch([runPayload({ id: 'child-1', status: 'failed', error_code: 'render_failed' }), runPayload({ id: 'child-2', status: 'failed', error_code: 'drive_delivery_failed' }), runPayload({ id: 'child-3', status: 'failed', error_code: null })], { error_message: null }), [`${GUIDE}#render_failed`, `${GUIDE}#drive_delivery_failed`]],
		['a batch with no file listed', batch([], { error_message: null }), [REFERENCE]],
		['a batch with no file listed but a code of its own', batch([], { error_message: null, error_code: 'all_distributions_failed' }), [`${GUIDE}#all_distributions_failed`]],
	])('%s', async (_title, router, links) => {
		const api = await startApi(router);

		const error = expectWording(errorOf(await run(api, s2dConnected(waiting))));

		for (const link of links) expect(error.description).toContain(link);
		expect(error.description).not.toContain('#a-start');
	});

	it.each([
		['an Idempotency Key that is a list', s2dConnected({ idempotencyKey: '={{ [1] }}' }), "'Idempotency Key'"],
		['a Max Wait that is not a number', s2dConnected({ waitForCompletion: true, maxWait: "={{ 'soon' }}" }), "'Max Wait (Seconds)'"],
		['Rows that are not JSON', s2dJson([{ dataSetId: DS_ID, rows: '={{ "not json" }}' }]), "'Rows'"],
		['an entry with no Data Set', s2dJson([{ dataSetId: '', rows: '[]' }]), "'Data Set'"],
		['Map Columns with nothing mapped', s2dMapped({}), "'Map Columns'"],
		['Map Columns with the mapped Data Set listed again', s2dMapped({ 'Client name': 'x' }, { additionalDataSets: { values: [{ dataSetId: DS_ID, rows: '[]' }] } }), "'Additional Data Sets'"],
		['a Deliver To that is not a list', s2dConnected({ distributionIds: '={{ "x" }}' }), "'Deliver To'"],
		['Selected Fields with nothing selected', s2dConnected({ output: 'selected', outputFields: [] }, {}), "'Fields'"],
	])('%s names its parameter and sends nothing', async (_title, node, quoted) => {
		const api = await startApi(defaultRouter());

		const result = await run(api, { ...node, typeVersion: 1.1 } as TestNode);

		const error = expectWording(errorOf(result));
		expect(`${error.message} ${error.description}`).toContain(quoted);
		expect(api.posts()).toHaveLength(0);
	});
});

describe('the words of each way a read stops', () => {
	it('an operation the node does not have', async () => {
		const api = await startApi(defaultRouter());

		expectWording(errorOf(await run(api, s2d({ resource: 'project', operation: 'delete' }))));
	});

	it('a Limit that is not a whole number', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		const error = expectWording(errorOf(await run(api, { ...s2d({ resource: 'project', operation: 'getMany', returnAll: false, limit: '=0' }), typeVersion: 1.1 } as TestNode)));

		expect(error.message).toContain("'Limit'");
	});

	it('a Run ID that is not an ID', async () => {
		const api = await startApi(defaultRouter());

		const error = expectWording(errorOf(await run(api, s2d({ resource: 'run', operation: 'get', runId: 'nope' }))));

		expect(error.message).toMatch(/^'Run ID' is not a valid ID/);
	});

	it('a credential with no Base URL', async () => {
		const api = await startApi(defaultRouter());

		const result = await runWorkflow({
			baseUrl: '   ',
			nodes: [emit([{ json: {} }]), s2d({ resource: 'project', operation: 'getMany' })],
			connections: [['Emit', 'SourceToDocs']],
		});

		expectWording(errorOf(result));
		expect(api.requests).toHaveLength(0);
	});
});

describe('the item a read stops on', () => {
	const ids = ['e0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-00000000000c'];
	const input = ids.map((run) => ({ json: { run } }));
	const reader = () => s2d({ resource: 'run', operation: 'get', runId: '={{ $json.run }}' });

	it('a 422 on item 2 of 3 carries its index, which n8n shows after the message, and the next step', async () => {
		const api = await startApi((request) =>
			request.path.endsWith(ids[1])
				? failure(422, 'validation', 'The given data was invalid.', { run_id: ['must belong to this workspace'] })
				: ok({ run: runPayload({ id: request.path.slice(`${API_PATH}/runs/`.length), status: 'succeeded' }) }),
		);

		const error = expectWording(errorOf(await run(api, reader(), input)));

		expect(error.name).toBe('NodeApiError');
		expect(error.context).toMatchObject({ itemIndex: 1 });
		expect(error.description).toContain('run_id: must belong to this workspace');
	});

	it('an ID refused on item 2 of 3 names its parameter in quotes and carries its index', async () => {
		const api = await startApi(defaultRouter());

		const error = expectWording(errorOf(await run(api, reader(), [input[0], { json: { run: 'not-an-id' } }, input[2]])));

		expect(error.message).toMatch(/^'Run ID' is not a valid ID/);
		expect(error.context).toMatchObject({ itemIndex: 1 });
	});
});

describe('a request too big for the API, and a source with too many rows', () => {
	const refused = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) =>
		failure(status, 'validation', message, { code: [code], ...extra });

	it('413 request_body_too_large says what happened, how many rows fit, and the way out', async () => {
		const api = await startApi(() => refused(413, 'The request body is larger than 2 MB.', 'request_body_too_large'));

		const result = await run(api, s2dJson([{ dataSetId: DS_ID, rows: '[{"Client name":"A"}]' }], { unknownKeys: 'refuse' }));

		const error = expectWording(errorOf(result));
		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe("The rows are too large to send in one run: the request is over the API's 2 MiB limit");
		expect(error.description).toContain('Nothing was started');
		expect(error.description).toContain('15 000');
		expect(error.description).toContain('fewer rows per run');
		expect(error.description).toContain('The API said: The request body is larger than 2 MB');
		expect(api.posts()).toHaveLength(1);
	});

	it('422 source_too_large says what happened and the way out, and keeps the code as a fact for Continue On Fail', async () => {
		const api = await startApi(() => refused(422, "inline_data for data set 'Lines' has more rows than the maximum allowed 100000.", 'source_too_large', { data_set_id: [DS_ID] }));

		const result = await run(api, { ...s2dJson([{ dataSetId: DS_ID, rows: '[{"Client name":"A"}]' }], { unknownKeys: 'refuse' }), continueOnFail: true } as TestNode);

		const item = result.json('SourceToDocs')[0];
		expect(item.error).toBe('A Data Set has more rows than one run may hold');
		expect(item.error_code).toBe('source_too_large');
		expect(item.errors).toMatchObject({ data_set_id: [DS_ID] });
	});
});

describe('a workflow saved before the Unknown Fields label', () => {
	// A saved workflow holds the parameter's name, never its label, so the new label changes nothing it runs.
	it.each([
		['JSON', s2dJson([{ dataSetId: DS_ID, rows: '[{"id":"rec1","Client name":"A"}]' }], { unknownKeys: 'refuse' })],
		['Map Columns', s2dMapped(null, { unknownKeys: 'refuse' }, 'autoMapInputData')],
	])('still reads unknownKeys: refuse in %s mode, sending the rows as given', async (_mode, node) => {
		const api = await startApi(defaultRouter());

		const result = await run(api, node, [{ json: { id: 'rec1', 'Client name': 'A' } }]);

		expect(errorOf(result)).toBeUndefined();
		expect(bodyOf(api.posts()[0])).toEqual({ inline_data: { [DS_ID]: [{ id: 'rec1', 'Client name': 'A' }] } });
	});
});
