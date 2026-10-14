import type { INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	applySimplify,
	clampWaitOptions,
	flattenBatchChildren,
	flattenBatchResult,
	flattenRun,
	resolveWaitOptions,
	waitForTerminalRun,
	withRunId,
} from '../nodes/SourceToDocs/runs';
import { keyAfterFailedRun } from '../nodes/SourceToDocs/startRun';
import type { RunData } from '../nodes/SourceToDocs/types';

const node: INode = {
	id: 'node-1',
	name: 'SourceToDocs',
	type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function singleRun(overrides: Partial<RunData> = {}): RunData {
	return {
		id: 'run-1',
		document_id: 'doc-1',
		workspace_id: 'ws-1',
		kind: 'single',
		split_key: null,
		idempotency_key: 'key-1',
		status: 'pending',
		file_count: null,
		progress: null,
		output_result: null,
		error_code: null,
		error_message: null,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		distributions: [],
		...overrides,
	};
}

describe('flattenRun', () => {
	it('flattens a Google Slides output_result to file_url/file_name/page_count', () => {
		const run = singleRun({
			status: 'succeeded',
			output_result: {
				presentation_id: 'p-1',
				presentation_url: 'https://docs.google.com/presentation/d/p-1',
				presentation_name: 'Weekly report',
				slide_count: 7,
				source_presentation_id: 'src-1',
				source_name: 'Template',
			},
		});

		const item = flattenRun(run);

		expect(item).toMatchObject({
			run_id: 'run-1',
			status: 'succeeded',
			kind: 'single',
			split_key: null,
			file_url: 'https://docs.google.com/presentation/d/p-1',
			file_name: 'Weekly report',
			page_count: 7,
			error_code: null,
			error_message: null,
		});
		expect(item.run).toBe(run);
	});

	it('flattens a Google Docs output_result the same way, from its own page_count', () => {
		const run = singleRun({
			status: 'succeeded',
			output_result: {
				document_id: 'd-1',
				document_url: 'https://docs.google.com/document/d/d-1',
				document_name: 'Invoice',
				page_count: 2,
				source_document_id: 'src-1',
				source_name: 'Template',
			},
		});

		expect(flattenRun(run)).toMatchObject({
			file_url: 'https://docs.google.com/document/d/d-1',
			file_name: 'Invoice',
			page_count: 2,
		});
	});

	it('nulls the file fields while there is no output_result yet', () => {
		expect(flattenRun(singleRun())).toMatchObject({
			file_url: null,
			file_name: null,
			page_count: null,
		});
	});

	it("flattens each delivery to id, type, status, its result, and its error", () => {
		const run = singleRun({
			distributions: [
				{
					id: 'dist-run-1',
					run_id: 'run-1',
					distribution_id: 'dist-1',
					distribution_type: 'google_drive',
					status: 'succeeded',
					result: { file_id: 'f-1', web_view_link: 'https://drive/f-1' },
					error_code: null,
					error_message: null,
					attempted_at: '2026-01-01T00:00:01Z',
					finished_at: '2026-01-01T00:00:02Z',
					created_at: '2026-01-01T00:00:00Z',
					updated_at: '2026-01-01T00:00:02Z',
				},
			],
		});

		expect(flattenRun(run).deliveries).toEqual([
			{
				id: 'dist-run-1',
				type: 'google_drive',
				status: 'succeeded',
				result: { file_id: 'f-1', web_view_link: 'https://drive/f-1' },
				error_code: null,
				error_message: null,
			},
		]);
	});

	it('surfaces the run_s own file_count and progress at the top level', () => {
		const run = singleRun({
			kind: 'batch',
			file_count: 3,
			progress: { total: 3, succeeded: 3, failed: 0, partial_success: 0, cancelled: 0, processing: 0, pending: 0 },
		});

		expect(flattenRun(run)).toMatchObject({ file_count: 3 });
		expect(flattenRun(run).progress).toEqual(run.progress);
	});

	it('does not crash when output_result is omitted entirely, not just null', () => {
		const run = singleRun({ status: 'succeeded' });
		// `public-api.json` marks `output_result` optional, not required — simulate a wire answer
		// that leaves the key out altogether, which reads as `undefined`, not `null`.
		delete (run as Partial<RunData>).output_result;

		expect(() => flattenRun(run)).not.toThrow();
		expect(flattenRun(run)).toMatchObject({ file_url: null, file_name: null, page_count: null });
	});
});

describe('flattenBatchChildren', () => {
	it("adds the root's batch_run_id, file_count and progress to every child", () => {
		const root = singleRun({
			id: 'batch-1',
			kind: 'batch',
			status: 'succeeded',
			file_count: 2,
			progress: {
				total: 2,
				succeeded: 2,
				failed: 0,
				partial_success: 0,
				cancelled: 0,
				processing: 0,
				pending: 0,
			},
		});
		const children = [
			singleRun({ id: 'child-1', split_key: 'Acme' }),
			singleRun({ id: 'child-2', split_key: 'Globex' }),
		];

		const items = flattenBatchChildren(root, children);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ run_id: 'child-1', split_key: 'Acme', batch_run_id: 'batch-1', file_count: 2 });
		expect(items[1]).toMatchObject({ run_id: 'child-2', split_key: 'Globex', batch_run_id: 'batch-1', file_count: 2 });
	});
});

describe('flattenBatchResult', () => {
	it('lists the children when there are any', () => {
		const root = singleRun({ id: 'batch-1', kind: 'batch', status: 'succeeded', file_count: 1 });
		const children = [singleRun({ id: 'child-1' })];

		expect(flattenBatchResult(root, children)).toHaveLength(1);
	});

	it('returns the batch itself, flattened, as the one item when there are no children', () => {
		const root = singleRun({ id: 'batch-1', kind: 'batch', status: 'succeeded', file_count: 0 });

		const items = flattenBatchResult(root, []);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ run_id: 'batch-1', file_count: 0 });
	});
});

describe('applySimplify', () => {
	it('strips the run object when simplify is on', () => {
		const run = singleRun();
		expect(applySimplify([flattenRun(run)], true)[0]).not.toHaveProperty('run');
	});

	it('keeps the run object when simplify is off', () => {
		const run = singleRun();
		expect(applySimplify([flattenRun(run)], false)[0].run).toEqual(run);
	});
});

describe('clampWaitOptions', () => {
	it('clamps Poll Every up to the 2 s minimum', () => {
		expect(clampWaitOptions(300, 0)).toMatchObject({ pollEveryMs: 2000 });
		expect(clampWaitOptions(300, 1)).toMatchObject({ pollEveryMs: 2000 });
	});

	it('leaves a Poll Every at or above the minimum alone', () => {
		expect(clampWaitOptions(300, 5)).toMatchObject({ pollEveryMs: 5000 });
	});

	it('clamps Max Wait up to at least one poll interval', () => {
		expect(clampWaitOptions(1, 5)).toMatchObject({ maxWaitMs: 5000, pollEveryMs: 5000 });
	});

	it('clamps Max Wait down to the 3600 s cap', () => {
		expect(clampWaitOptions(999_999, 5)).toMatchObject({ maxWaitMs: 3_600_000 });
	});

	it('passes sane values through unchanged', () => {
		expect(clampWaitOptions(300, 5)).toEqual({ maxWaitMs: 300_000, pollEveryMs: 5000 });
	});
});

describe('clampWaitOptions, Poll Every maximum', () => {
	it('clamps Poll Every down to the same 3600 s cap as Max Wait', () => {
		expect(clampWaitOptions(300, 999_999)).toEqual({ pollEveryMs: 3_600_000, maxWaitMs: 3_600_000 });
	});
});

describe('resolveWaitOptions', () => {
	it.each([undefined, null, '', '   '])('takes the defaults (300 s, 5 s) for %j', (empty) => {
		expect(resolveWaitOptions(node, empty, empty)).toEqual({ maxWaitMs: 300_000, pollEveryMs: 5000 });
	});

	it('converts a numeric string, then clamps', () => {
		expect(resolveWaitOptions(node, '60', '10')).toEqual({ maxWaitMs: 60_000, pollEveryMs: 10_000 });
		expect(resolveWaitOptions(node, '9999999', '0')).toEqual({ maxWaitMs: 3_600_000, pollEveryMs: 2000 });
	});

	it.each([
		['Max Wait (Seconds)', 'soon', 5],
		['Poll Every (Seconds)', 5, 'often'],
		['Max Wait (Seconds)', Number.NaN, 5],
		['Poll Every (Seconds)', 300, Number.POSITIVE_INFINITY],
		['Max Wait (Seconds)', {}, 5],
		['Poll Every (Seconds)', 300, true],
	])('refuses a value that is not a number, naming %s', (parameter, maxWait, pollEvery) => {
		expect(() => resolveWaitOptions(node, maxWait, pollEvery)).toThrow(`'${parameter}' is not a number`);
		expect(() => resolveWaitOptions(node, maxWait, pollEvery)).toThrow(NodeOperationError);
	});
});

describe('withRunId', () => {
	it("appends the run's id to a NodeOperationError's description and sets context.runId", () => {
		const error = new NodeOperationError(node, 'The run ended before the document was produced', { description: 'Error code: render_failed' });

		const decorated = withRunId(error, 'run-1');

		expect(decorated.description).toBe('Error code: render_failed. Run ID: run-1');
		expect(decorated.context.runId).toBe('run-1');
	});

	it('sets the description to just the run id when there was none', () => {
		const error = new NodeOperationError(node, 'The run ended before the document was produced');
		error.description = undefined;

		const decorated = withRunId(error, 'run-1');

		expect(decorated.description).toBe('Run ID: run-1');
	});

	it('decorates a description that is 1 000 000 dots in under 50 ms', () => {
		const error = new NodeOperationError(node, 'x', { description: '.'.repeat(1_000_000) });

		const start = performance.now();
		withRunId(error, 'run-1');

		expect(performance.now() - start).toBeLessThan(50);
		expect(error.description!.length).toBeLessThan(2100);
		expect(error.description!.endsWith('. Run ID: run-1')).toBe(true);
	});

	it('is idempotent: decorating twice with the same id does not duplicate the mention', () => {
		const error = new NodeOperationError(node, 'The run ended before the document was produced', { description: 'Error code: x' });

		withRunId(error, 'run-1');
		withRunId(error, 'run-1');

		expect(error.description).toBe('Error code: x. Run ID: run-1');
	});

	it('leaves a plain Error untouched (nothing to attach context to)', () => {
		const error = new Error('boom');

		expect(withRunId(error, 'run-1')).toBe(error);
	});

	it('trims a trailing full stop before appending, so a sentence-ending description does not end "..", measured live against a failed Split deck batch', () => {
		const error = new NodeOperationError(node, 'The batch run ended before all of its documents were produced', {
			description: 'Batch run_id: batch-1. Failed children: child-1 (google_slides_presentation_missing).',
		});

		withRunId(error, 'batch-1');

		expect(error.description).toBe(
			'Batch run_id: batch-1. Failed children: child-1 (google_slides_presentation_missing). Run ID: batch-1',
		);
	});
});

// fetchRun / fetchRunChildren need a real n8n context: they run on the engine
// (test-engine/test/reads.engine.test.ts). waitForTerminalRun below takes its clock, sleep and
// fetch as injected seams and no n8n context, so its cases stay plain: real time cannot be
// faked through the engine, and the engine layer keeps its waiting cases few.

describe('waitForTerminalRun', () => {
	it('polls zero times when the initial Run is already terminal', async () => {
		const sleep = vi.fn(async () => {});
		const fetchRunDep = vi.fn();
		const initial = singleRun({ status: 'succeeded' });

		const result = await waitForTerminalRun(
			{} as never,
			'run-1',
			initial,
			{ maxWaitMs: 10_000, pollEveryMs: 1_000 },
			{ sleep, fetchRun: fetchRunDep },
		);

		expect(result).toEqual({ run: initial, timedOut: false });
		expect(sleep).not.toHaveBeenCalled();
		expect(fetchRunDep).not.toHaveBeenCalled();
	});

	it('polls until a terminal status, one fetch per poll', async () => {
		const sleep = vi.fn(async () => {});
		const polls = [singleRun({ status: 'processing' }), singleRun({ status: 'succeeded' })];
		const fetchRunDep = vi.fn(async () => polls.shift() as RunData);

		const result = await waitForTerminalRun(
			{} as never,
			'run-1',
			singleRun({ status: 'pending' }),
			{ maxWaitMs: 10_000, pollEveryMs: 1_000 },
			{ sleep, fetchRun: fetchRunDep },
		);

		expect(result).toEqual({ run: singleRun({ status: 'succeeded' }), timedOut: false });
		expect(fetchRunDep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1_000);
	});

	it('stops and reports timed out once Max Wait elapses, without exceeding it', async () => {
		const sleep = vi.fn(async () => {});
		const fetchRunDep = vi.fn(async () => singleRun({ status: 'processing' }));

		const result = await waitForTerminalRun(
			{} as never,
			'run-1',
			singleRun({ status: 'pending' }),
			{ maxWaitMs: 10_000, pollEveryMs: 5_000 },
			{ sleep, fetchRun: fetchRunDep },
		);

		expect(result.timedOut).toBe(true);
		expect(result.run.status).toBe('processing');
		// Exactly two polls: elapsed 5s then 10s, both < the 10s deadline is false on the 2nd
		// check only after reaching it, so it polls at 5s and 10s before giving up.
		expect(fetchRunDep).toHaveBeenCalledTimes(2);
	});

	it.each(['succeeded', 'failed', 'partial_success', 'cancelled'] as const)(
		'treats %s as terminal, stopping immediately',
		async (status) => {
			const sleep = vi.fn(async () => {});
			const fetchRunDep = vi.fn();

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status }),
				{ maxWaitMs: 10_000, pollEveryMs: 1_000 },
				{ sleep, fetchRun: fetchRunDep },
			);

			expect(result.timedOut).toBe(false);
			expect(fetchRunDep).not.toHaveBeenCalled();
		},
	);

	it.each(['pending', 'processing', 'cancelling'] as const)(
		'does not treat %s as terminal',
		async (status) => {
			const sleep = vi.fn(async () => {});
			const fetchRunDep = vi.fn(async () => singleRun({ status: 'succeeded' }));

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status }),
				{ maxWaitMs: 10_000, pollEveryMs: 1_000 },
				{ sleep, fetchRun: fetchRunDep },
			);

			expect(fetchRunDep).toHaveBeenCalledTimes(1);
			expect(result.run.status).toBe('succeeded');
		},
	);

	/** A `NodeApiError` the transport would throw for `httpCode`, optionally with a Retry-After. */
	function apiError(httpCode: string, retryAfterMs?: number): NodeApiError {
		const error = new NodeApiError(node, {}, { httpCode, message: `HTTP ${httpCode}` });
		if (retryAfterMs !== undefined) {
			error.context.retryAfterMs = retryAfterMs;
		}
		return error;
	}

	// A transient answer while polling is retried within Max Wait, never losing the run.
	describe('retrying a transient (429/5xx) poll answer', () => {
		it('retries a 429 and still reaches the terminal status, without losing it', async () => {
			const sleep = vi.fn(async () => {});
			const attempts = [() => Promise.reject(apiError('429')), () => Promise.resolve(singleRun({ status: 'succeeded' }))];
			const fetchRunDep = vi.fn(() => attempts.shift()!());

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 60_000, pollEveryMs: 5_000 },
				{ sleep, fetchRun: fetchRunDep },
			);

			expect(result).toEqual({ run: singleRun({ status: 'succeeded' }), timedOut: false });
			expect(fetchRunDep).toHaveBeenCalledTimes(2);
		});

		it.each(['500', '502', '503', '504'])('retries a %s the same way', async (httpCode) => {
			const sleep = vi.fn(async () => {});
			const attempts = [
				() => Promise.reject(apiError(httpCode)),
				() => Promise.resolve(singleRun({ status: 'succeeded' })),
			];
			const fetchRunDep = vi.fn(() => attempts.shift()!());

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 60_000, pollEveryMs: 5_000 },
				{ sleep, fetchRun: fetchRunDep },
			);

			expect(result.timedOut).toBe(false);
			expect(result.run.status).toBe('succeeded');
		});

		it('honours Retry-After, bounded by the time remaining in Max Wait', async () => {
			const sleepCalls: number[] = [];
			const sleep = vi.fn(async (ms: number) => {
				sleepCalls.push(ms);
			});
			const attempts = [
				() => Promise.reject(apiError('429', 10_000)),
				() => Promise.resolve(singleRun({ status: 'succeeded' })),
			];
			const fetchRunDep = vi.fn(() => attempts.shift()!());

			await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 3_000, pollEveryMs: 1_000 },
				{ sleep, fetchRun: fetchRunDep, now: () => 0 },
			);

			// The outer poll sleeps 1_000; the retry would want 10_000 but only 2_000 is left. A frozen
			// clock: the time a failed poll itself took is now taken off the budget too.
			expect(sleepCalls).toEqual([1_000, 2_000]);
		});

		// A poll that timed out is as transient as a 5xx, and no poll may outlive what is left of Max Wait.
		it('retries a poll that timed out, giving each poll the time left of Max Wait (at least 5 s)', async () => {
			const sleep = vi.fn(async () => {});
			const timeout = apiError('');
			timeout.context.timedOut = true;
			const attempts = [() => Promise.reject(timeout), () => Promise.resolve(singleRun({ status: 'succeeded' }))];
			const timeouts: number[] = [];
			const fetchRunDep = vi.fn((_id: string, timeoutMs: number) => {
				timeouts.push(timeoutMs);
				return attempts.shift()!();
			});

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 60_000, pollEveryMs: 2_000 },
				{ sleep, fetchRun: fetchRunDep, now: () => 0 },
			);

			expect(result.run.status).toBe('succeeded');
			expect(timeouts).toEqual([58_000, 56_000]);
		});

		it('gives a poll started with nothing left a floor of 5 s, never none', async () => {
			const sleep = vi.fn(async () => {});
			const timeouts: number[] = [];
			const fetchRunDep = vi.fn(async (_id: string, timeoutMs: number) => {
				timeouts.push(timeoutMs);
				return singleRun({ status: 'succeeded' });
			});

			await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 2_000, pollEveryMs: 2_000 },
				{ sleep, fetchRun: fetchRunDep, now: () => 0 },
			);

			expect(timeouts).toEqual([5_000]);
		});

		it('takes the time a failed poll itself used off the budget', async () => {
			const sleepCalls: number[] = [];
			const sleep = vi.fn(async (ms: number) => {
				sleepCalls.push(ms);
			});
			let clock = 0;
			const fetchRunDep = vi.fn(async () => {
				clock += 10_000;
				throw apiError('503');
			});

			await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 15_000, pollEveryMs: 2_000 },
				{ sleep, fetchRun: fetchRunDep, now: () => clock },
			).catch(() => undefined);

			// 15 s - 2 s (first sleep) = 13 s left; the failed poll took 10 s, so 3 s remain: one retry
			// wait of 2 s, then a 1 s poll that fails again with nothing left.
			expect(sleepCalls).toEqual([2_000, 2_000]);
			expect(fetchRunDep).toHaveBeenCalledTimes(2);
		});

		it('reports the run as timed out, not an error, once retries exhaust the budget', async () => {
			const sleep = vi.fn(async () => {});
			const fetchRunDep = vi.fn(async () => Promise.reject(apiError('429')));

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 1_000, pollEveryMs: 1_000 },
				{ sleep, fetchRun: fetchRunDep },
			);

			expect(result.timedOut).toBe(true);
			expect(result.run.status).toBe('pending');
		});

		it.each(['500', '503'])('reports the run as timed out when the last poll answers %s', async (code) => {
			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 1_000, pollEveryMs: 1_000 },
				{ sleep: async () => {}, fetchRun: async () => Promise.reject(apiError(code)) },
			);

			expect(result.timedOut).toBe(true);
		});

		it('still throws a non-transient error on the last poll, with the run id', async () => {
			const error = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 1_000, pollEveryMs: 1_000 },
				{ sleep: async () => {}, fetchRun: async () => Promise.reject(apiError('404')) },
			).catch((caught: unknown) => caught);

			expect((error as NodeApiError).context.runId).toBe('run-1');
		});

		it('retries a dropped connection (no numeric status) like a 5xx', async () => {
			const fetchRunDep = vi
				.fn()
				.mockRejectedValueOnce(apiError('ECONNRESET'))
				.mockResolvedValueOnce(singleRun({ status: 'succeeded' }));

			const result = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 60_000, pollEveryMs: 5_000 },
				{ sleep: async () => {}, fetchRun: fetchRunDep },
			);

			expect(result).toMatchObject({ timedOut: false, run: { status: 'succeeded' } });
			expect(fetchRunDep).toHaveBeenCalledTimes(2);
		});

		it('does not retry a non-transient error, and still carries the run id', async () => {
			const sleep = vi.fn(async () => {});
			const fetchRunDep = vi.fn(async () => Promise.reject(apiError('404')));

			const error = await waitForTerminalRun(
				{} as never,
				'run-1',
				singleRun({ status: 'pending' }),
				{ maxWaitMs: 60_000, pollEveryMs: 5_000 },
				{ sleep, fetchRun: fetchRunDep },
			).catch((caught: unknown) => caught);

			expect(fetchRunDep).toHaveBeenCalledTimes(1);
			expect((error as NodeApiError).context.runId).toBe('run-1');
		});
	});
});

describe('keyAfterFailedRun', () => {
	const id = 'b0000000-0000-4000-8000-000000000001';

	it('appends :after: and the failed run id, the same every time', () => {
		expect(keyAfterFailedRun('monthly', id)).toBe(`monthly:after:${id}`);
		expect(keyAfterFailedRun('monthly', id)).toBe(keyAfterFailedRun('monthly', id));
	});

	it('cuts the end of a long key, never the run id, to stay at 255 characters', () => {
		const derived = keyAfterFailedRun('k'.repeat(255), id);
		expect(derived).toHaveLength(255);
		expect(derived.endsWith(`:after:${id}`)).toBe(true);
	});
});
