/**
 * With "Continue (using error output)" the error items reach
 * output 1 and the success branch does not run; with "Continue" they stay on output 0.
 * Every case runs in both modes: a 422 on Generate, a run ending `failed`, a failed batch (one
 * item per failed child), and a Run → Get answering 404 for 1 of 3 items.
 *
 * The items never carry `item.error`: n8n would replace their json with `{ error: message }`
 * (workflow-execute.js, after the node ran) and downstream nodes would lose error_code, run_id, ...
 * - `continueRegularOutput` and the legacy `continueOnFail: true`: the flat json, `{ error, ...facts }`.
 * - `continueErrorOutput`: `{ error, details: {...facts} }`, the keys `handleNodeErrorOutput`
 *   routes by. n8n then spreads the paired INPUT item's json under ours (`{ ...input.json, ...item.json }`).
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	defaultRouter,
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

type Mode = 'regular' | 'legacy' | 'errorOutput';
const modes: Mode[] = ['regular', 'legacy', 'errorOutput'];
const nodeFlags = (mode: Mode): Partial<TestNode> =>
	mode === 'regular'
		? { onError: 'continueRegularOutput' }
		: mode === 'legacy'
			? { continueOnFail: true }
			: { onError: 'continueErrorOutput' };

/** Emit -> SourceToDocs, whose output 0 feeds `Success` and output 1 feeds `Failure`. */
async function run(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [
			emit(items),
			node,
			{ name: 'Success', type: 'test.capture', parameters: { value: '={{ $json.error }}' } },
			{ name: 'Failure', type: 'test.capture', parameters: { value: '={{ $json.error }}' } },
		],
		connections: [
			['Emit', 'SourceToDocs'],
			['SourceToDocs', 'Success', 0],
			['SourceToDocs', 'Failure', 1],
		],
	});
}

const waiting = { waitForCompletion: true, maxWait: 300, pollEvery: 5 };
const pairedAll = (n: number) => Array.from({ length: n }, (_v, item) => ({ item }));

/** The output an error item lands on, and the branch that must not have run. */
function routes(mode: Mode) {
	return mode === 'errorOutput'
		? { out: 1, other: 0, ran: 'Failure', idle: 'Success' }
		: { out: 0, other: 1, ran: 'Success', idle: 'Failure' };
}

describe.each(modes)('Generate answered 422 (%s)', (mode) => {
	const router: Router = () =>
		failure(422, 'validation', 'Unknown columns.', { code: ['inline_column_unknown'], unknown_keys: ['x'] });
	const facts = {
		error_code: 'inline_column_unknown',
		category: 'validation',
		errors: { code: ['inline_column_unknown'], unknown_keys: ['x'] },
	};

	it('routes the one error item by mode, in the mode shape, paired to every input item', async () => {
		const api = await startApi(router);

		const result = await run(api, s2dConnected({}, nodeFlags(mode)), [{ json: { a: 1 } }, { json: { a: 2 } }]);

		const r = routes(mode);
		expect(result.run.status).toBe('success');
		const items = result.items('SourceToDocs', 0, r.out);
		expect(items).toHaveLength(1);
		expect(result.items('SourceToDocs', 0, r.other)).toHaveLength(0);
		expect(items[0].error).toBeUndefined();
		expect(items[0].json).toEqual(
			mode === 'errorOutput'
				? { a: 1, error: 'Unknown columns.', details: facts }
				: { error: 'Unknown columns.', ...facts },
		);
		expect(items[0].pairedItem).toEqual(pairedAll(2));
		expect(result.order).toContain(r.ran);
		expect(result.order).not.toContain(r.idle);
	});
});

describe.each(modes)('Generate, a run that ends failed (%s)', (mode) => {
	const message = 'The document was deleted before this run could render it.';

	it('routes the error item by mode, carrying the API code and the run id', async () => {
		const api = await startApi(
			defaultRouter(runPayload({ status: 'failed', error_code: 'render_failed', error_message: message })),
		);

		const result = await run(api, s2dConnected(waiting, nodeFlags(mode)), [{ json: { a: 1 } }, { json: { a: 2 } }]);

		const r = routes(mode);
		const items = result.items('SourceToDocs', 0, r.out);
		expect(items).toHaveLength(1);
		expect(result.items('SourceToDocs', 0, r.other)).toHaveLength(0);
		expect(items[0].error).toBeUndefined();
		expect(items[0].json).toEqual(
			mode === 'errorOutput'
				? { a: 1, error: message, details: { error_code: 'render_failed', run_id: 'b0000000-0000-4000-8000-000000000001' } }
				: { error: message, error_code: 'render_failed', run_id: 'b0000000-0000-4000-8000-000000000001' },
		);
		expect(items[0].pairedItem).toEqual(pairedAll(2));
		expect(result.order).toContain(r.ran);
		expect(result.order).not.toContain(r.idle);
		expect(result.json(r.ran)).toEqual([{ value: message }]);
	});
});

describe.each(modes)('Generate, a failed batch (%s)', (mode) => {
	it('puts one item per failed child on the chosen output', async () => {
		const children = [
			runPayload({ id: 'child-1', status: 'failed', error_code: 'render_failed', error_message: 'Template broken.', split_key: 'A' }),
			runPayload({ id: 'child-2', status: 'succeeded' }),
			runPayload({ id: 'child-3', status: 'failed', error_code: 'timeout', error_message: null, split_key: 'C' }),
		];
		const router: Router = (request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed', error_message: 'The batch had failures.' }) }, 201)
				: ok({ runs: children });
		const api = await startApi(router);

		const result = await run(api, s2dConnected(waiting, nodeFlags(mode)), [{ json: { a: 1 } }, { json: { a: 2 } }]);

		const r = routes(mode);
		const items = result.items('SourceToDocs', 0, r.out);
		expect(items).toHaveLength(2);
		expect(result.items('SourceToDocs', 0, r.other)).toHaveLength(0);
		const facts = [
			{ batch_run_id: 'c0000000-0000-4000-8000-000000000001', run_id: 'child-1', error_code: 'render_failed', error_message: 'Template broken.', split_key: 'A' },
			{ batch_run_id: 'c0000000-0000-4000-8000-000000000001', run_id: 'child-3', error_code: 'timeout', error_message: null, split_key: 'C' },
		];
		expect(items.map((i) => i.json)).toEqual(
			facts.map((f) =>
				mode === 'errorOutput'
					? { a: 1, error: 'The batch had failures.', details: f }
					: { error: 'The batch had failures.', ...f },
			),
		);
		expect(items.every((i) => i.error === undefined)).toBe(true);
		expect(items.map((i) => i.pairedItem)).toEqual([pairedAll(2), pairedAll(2)]);
		expect(result.order).toContain(r.ran);
		expect(result.order).not.toContain(r.idle);
		expect(result.json(r.ran)).toHaveLength(2);
	});
});

describe.each(modes)('Run → Get answering 404 for 1 of 3 items (%s)', (mode) => {
	const runs: Record<string, unknown> = {
		'e0000000-0000-4000-8000-00000000000a': runPayload({ id: 'e0000000-0000-4000-8000-00000000000a', status: 'succeeded' }),
		'e0000000-0000-4000-8000-00000000000c': runPayload({ id: 'e0000000-0000-4000-8000-00000000000c', status: 'succeeded' }),
	};
	const router: Router = (request) => {
		const id = request.path.slice(`${API_PATH}/runs/`.length);
		return id in runs ? ok({ run: runs[id] }) : failure(404, 'not_found', 'Resource not found.', { code: ['run_not_found'] });
	};
	const input = [{ json: { run: 'e0000000-0000-4000-8000-00000000000a' } }, { json: { run: 'e0000000-0000-4000-8000-0000000000f1' } }, { json: { run: 'e0000000-0000-4000-8000-00000000000c' } }];
	const reader = (): TestNode =>
		s2d({ resource: 'run', operation: 'get', runId: '={{ $json.run }}' }, nodeFlags(mode));
	const facts = { error_code: 'run_not_found', category: 'not_found', errors: { code: ['run_not_found'] } };

	it('keeps the good items and shapes the failing one by mode', async () => {
		const api = await startApi(router);

		const result = await run(api, reader(), input);

		expect(result.run.status).toBe('success');
		expect(api.requests).toHaveLength(3);
		const out0 = result.items('SourceToDocs', 0, 0);
		const out1 = result.items('SourceToDocs', 0, 1);
		if (mode === 'errorOutput') {
			expect(out0.map((i) => i.json.run_id)).toEqual(['e0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-00000000000c']);
			expect(out0.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
			expect(out1).toHaveLength(1);
			// n8n spreads the paired input item's json (`run: 'e0000000-0000-4000-8000-0000000000f1'`) under ours.
			expect(out1[0].json).toEqual({ run: 'e0000000-0000-4000-8000-0000000000f1', error: 'Resource not found.', details: facts });
			expect(out1[0].pairedItem).toEqual({ item: 1 });
			expect(result.order).toEqual(expect.arrayContaining(['Success', 'Failure']));
			expect(result.json('Success')).toHaveLength(2);
			expect(result.json('Failure')).toEqual([{ value: 'Resource not found.' }]);
		} else {
			expect(out1).toHaveLength(0);
			expect(out0).toHaveLength(3);
			expect(out0[1].json).toEqual({ error: 'Resource not found.', ...facts });
			expect(out0.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
			expect(result.order).toContain('Success');
			expect(result.order).not.toContain('Failure');
			expect(result.json('Success')).toHaveLength(3);
		}
		expect([...out0, ...out1].every((i) => i.error === undefined)).toBe(true);
	});

	it('names the failing item on the thrown error when there is no Continue On Fail', async () => {
		const api = await startApi(router);

		const result = await run(api, s2d({ resource: 'run', operation: 'get', runId: '={{ $json.run }}' }), input);

		const error = result.errorOf('SourceToDocs');
		expect(error?.name).toBe('NodeApiError');
		expect(error?.context).toMatchObject({ itemIndex: 1 });
		expect(api.requests).toHaveLength(2);
	});
});

describe.each(modes)('Document → Get answering 404 (%s)', (mode) => {
	it('routes the item by mode', async () => {
		const api = await startApi(() => failure(404, 'not_found', 'Resource not found.', { code: ['document_not_found'] }));

		const result = await run(
			api,
			s2d({ resource: 'document', operation: 'get', documentId: { __rl: true, mode: 'id', value: DOC_ID } }, nodeFlags(mode)),
		);

		const r = routes(mode);
		const items = result.items('SourceToDocs', 0, r.out);
		expect(items).toHaveLength(1);
		expect(result.items('SourceToDocs', 0, r.other)).toHaveLength(0);
		const facts = { error_code: 'document_not_found', category: 'not_found', errors: { code: ['document_not_found'] } };
		expect(items[0].json).toEqual(
			mode === 'errorOutput'
				? { error: 'Resource not found.', details: facts }
				: { error: 'Resource not found.', ...facts },
		);
		expect(items[0].pairedItem).toEqual({ item: 0 });
		expect(result.order).not.toContain(r.idle);
	});
});
