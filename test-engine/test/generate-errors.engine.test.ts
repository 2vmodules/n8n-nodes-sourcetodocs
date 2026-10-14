/**
 * Document → Generate when the API says no, through n8n's own engine: the error the node throws,
 * and, with Continue On Fail, the items it leaves behind. Moved from the stubbed negativeCases and
 * node tests.
 *
 * The regular-output continueOnFail items are the flat `{ error, ...facts }` json; the error-output shape is in error-output.engine.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
	DOC_ID,
	defaultRouter,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2dConnected,
	bodyOf,
	useFakeApis,
	type FakeApi,
	type FakeReply,
	type Router,
	type TestNode,
} from './harness';

const startApi = useFakeApis();

const refusing = (reply: FakeReply): Router => () => reply;

async function generate(api: FakeApi, node: TestNode, items: unknown[] = [{ json: {} }]) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit(items), node],
		connections: [['Emit', 'SourceToDocs']],
	});
}

const continueOn = { onError: 'continueRegularOutput' as const };

interface NodeErrorCopy {
	name: string;
	message: string;
	description?: string;
	context: Record<string, unknown>;
}

const refusals: Array<{ title: string; reply: FakeReply; code?: string; category: string; message: string }> = [
	{
		title: 'a deleted document (404)',
		reply: failure(404, 'not_found', 'Resource not found.'),
		category: 'not_found',
		message: 'Resource not found.',
	},
	{
		title: "another workspace's document (404, worded like an unknown id)",
		reply: failure(404, 'not_found', 'Resource not found.'),
		category: 'not_found',
		message: 'Resource not found.',
	},
	{
		title: 'a deleted Data Set named in inline_data (422 inline_data_set_unknown)',
		reply: failure(422, 'validation', 'inline_data names a Data Set that does not exist.', {
			code: ['inline_data_set_unknown'],
			data_set_id: ['ds-gone'],
		}),
		code: 'inline_data_set_unknown',
		category: 'validation',
		message: 'inline_data names a Data Set that does not exist.',
	},
	{
		title: 'the quota used up (422 plan.limit_exceeded.generations)',
		reply: failure(422, 'plan', 'Plan limit for generations exceeded (used 3, limit 3).', {
			code: ['plan.limit_exceeded.generations'],
			metric: 'generations',
			limit: 3,
			used: 3,
		}),
		code: 'plan.limit_exceeded.generations',
		category: 'plan',
		message: 'Plan limit for generations exceeded (used 3, limit 3).',
	},
	{
		title: 'no active plan (422 plan.subscription_inactive)',
		reply: failure(422, 'plan', 'No active plan resolved for workspace.', { code: ['plan.subscription_inactive'] }),
		code: 'plan.subscription_inactive',
		category: 'plan',
		message: 'No active plan resolved for workspace.',
	},
	{
		title: 'every Deliver To id ignored (422 no_enabled_distributions)',
		reply: failure(422, 'business_rule', 'The document has no enabled distribution to deliver to.', {
			code: ['no_enabled_distributions'],
		}),
		code: 'no_enabled_distributions',
		category: 'business_rule',
		message: 'The document has no enabled distribution to deliver to.',
	},
	{
		title: 'a revoked token (401)',
		reply: failure(401, 'auth', 'Invalid API token.'),
		category: 'auth',
		message: 'Invalid API token.',
	},
];

describe('Generate when the API refuses the start', () => {
	it.each(refusals)('throws the API message and error code for $title', async ({ reply, code, message }) => {
		const api = await startApi(refusing(reply));

		const result = await generate(api, s2dConnected());

		const error = result.errorOf('SourceToDocs') as unknown as NodeErrorCopy;
		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe(message);
		if (code !== undefined) expect(error.description).toContain(`Code: ${code}`);
		expect(api.requests).toHaveLength(1);
		expect(result.run.status).toBe('error');
	});

	it.each(refusals)(
		'continueOnFail carries the message, error_code, category and errors for $title, with no run_id',
		async ({ reply, code, category, message }) => {
			const api = await startApi(refusing(reply));

			const result = await generate(api, s2dConnected({}, continueOn));

			const items = result.json('SourceToDocs');
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ error: message, category });
			if (code !== undefined) expect(items[0]).toMatchObject({ error_code: code });
			else expect(items[0]).not.toHaveProperty('error_code');
			expect(items[0]).not.toHaveProperty('run_id');
		},
	);

	it('carries the quota numbers on the continueOnFail item', async () => {
		const quota = refusals.find((r) => r.code === 'plan.limit_exceeded.generations')!;
		const api = await startApi(refusing(quota.reply));

		const result = await generate(api, s2dConnected({}, continueOn));

		expect(result.json('SourceToDocs')[0].errors).toEqual({
			code: ['plan.limit_exceeded.generations'],
			metric: 'generations',
			limit: 3,
			used: 3,
		});
	});

	it('passes Deliver To straight through and says nothing when the API ignores an id (201)', async () => {
		const api = await startApi(
			defaultRouter({ distributions: [{ id: 'rd-1', distribution_type: 'google_drive', status: 'pending' }] }),
		);

		const result = await generate(api, s2dConnected({ distributionIds: ['d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-0000000000a2'] }));

		// Every picked id goes to the API; the API decides which are valid and delivers to those.
		expect(bodyOf(api.posts()[0])).toEqual({ distribution_ids: ['d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-0000000000a2'] });
		// The node adds no warning of its own: one item, the run as the API answered it.
		const items = result.json('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ run_id: 'b0000000-0000-4000-8000-000000000001', status: 'pending' });
		expect(items[0]).not.toHaveProperty('warnings');
		expect(items[0]).not.toHaveProperty('error');
	});
});

describe('Generate, Continue On Fail after the run started', () => {
	const waiting = { waitForCompletion: true, maxWait: 300, pollEvery: 5 };
	const failedRun = runPayload({
		status: 'failed',
		error_code: 'render_failed',
		error_message: 'The document was deleted before this run could render it.',
	});

	it('a 422 with 2 input items: one error item paired to both, and the execution succeeds', async () => {
		const api = await startApi(
			refusing(
				failure(422, 'validation', 'Unknown columns.', { code: ['inline_column_unknown'], unknown_keys: ['x'], data_set_id: DOC_ID }),
			),
		);

		const result = await generate(api, s2dConnected({}, continueOn), [{ json: { x: 1 } }, { json: { x: 2 } }]);

		expect(result.run.status).toBe('success');
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0].json).toEqual({
			error: 'Unknown columns.',
			error_code: 'inline_column_unknown',
			category: 'validation',
			errors: { code: ['inline_column_unknown'], unknown_keys: ['x'], data_set_id: DOC_ID },
		});
		expect(items[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('a run that reached failed carries error_code and run_id, paired to every input item', async () => {
		const api = await startApi(defaultRouter(failedRun));

		const result = await generate(api, s2dConnected(waiting, continueOn), [{ json: {} }, { json: {} }]);

		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({
			error: 'The document was deleted before this run could render it.',
			error_code: 'render_failed',
			run_id: 'b0000000-0000-4000-8000-000000000001',
		});
		expect(items[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('a failed batch is one error item per failed child, each paired to every input item', async () => {
		const children = [
			runPayload({ id: 'child-1', status: 'failed', error_code: 'render_failed' }),
			runPayload({ id: 'child-2', status: 'succeeded' }),
			runPayload({ id: 'child-3', status: 'failed', error_code: 'timeout' }),
		];
		const router: Router = (request) =>
			request.method === 'POST' ? ok({ run: runPayload({ id: 'c0000000-0000-4000-8000-000000000001', kind: 'batch', status: 'failed' }) }, 201) : ok({ runs: children });
		const api = await startApi(router);

		const result = await generate(api, s2dConnected(waiting, continueOn), [{ json: {} }, { json: {} }]);

		const items = result.items('SourceToDocs');
		expect(items).toHaveLength(2);
		expect(items[0].json).toMatchObject({ run_id: 'child-1', error_code: 'render_failed', batch_run_id: 'c0000000-0000-4000-8000-000000000001' });
		expect(items[1].json).toMatchObject({ run_id: 'child-3', error_code: 'timeout', batch_run_id: 'c0000000-0000-4000-8000-000000000001' });
		expect(items[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
		expect(items[1].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});
});
