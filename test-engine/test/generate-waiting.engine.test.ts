/**
 * Generate waiting for a run through n8n's own engine. Real time cannot be faked here: each poll
 * costs at least Poll Every's 2 s floor, so these cases are few and each is its own test.
 */
import { describe, expect, it } from 'vitest';
import type { INodeParameters } from 'n8n-workflow';

import {
	API_PATH,
	emit,
	failure,
	ok,
	runPayload,
	runWorkflow,
	s2dConnected,
	useFakeApis,
	type FakeApi,
	type Router,
} from './harness';

const startApi = useFakeApis({ concurrent: true });

async function generate(api: FakeApi, parameters: INodeParameters) {
	return await runWorkflow({
		baseUrl: api.baseUrl,
		nodes: [emit([{ json: {} }]), s2dConnected({ waitForCompletion: true, ...parameters })],
		connections: [['Emit', 'SourceToDocs']],
	});
}

/** A router whose POST answers a run in `first` and whose polls answer from `onPoll`. */
function polling(first: string, onPoll: (pollNumber: number) => ReturnType<Router>): { router: Router; polls: () => number } {
	let polls = 0;
	return {
		polls: () => polls,
		router: (request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ status: first }) }, 201);
			polls += 1;
			return onPoll(polls);
		},
	};
}

describe.concurrent('Generate polling', () => {
	it('a run that is still processing at the 201 and succeeded at the first poll is one item', async () => {
		const { router, polls } = polling('processing', () =>
			ok({ run: runPayload({ status: 'succeeded', output_result: { document_url: 'https://docs.google.com/d/1', document_name: 'Invoice' } }) }),
		);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 300, pollEvery: 2 });

		expect(polls()).toBe(1);
		expect(api.gets()[0].path).toBe(`${API_PATH}/runs/b0000000-0000-4000-8000-000000000001`);
		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded', file_url: 'https://docs.google.com/d/1' });
		expect(result.ms).toBeGreaterThanOrEqual(1900);
	});

	it('a timed-out run is one item with timed_out: true, not an error', async () => {
		const { router, polls } = polling('pending', () => ok({ run: runPayload({ status: 'processing' }) }));
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 2, pollEvery: 2 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls()).toBe(1);
		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'processing', timed_out: true });
	});

	it('clamps Poll Every to 2 s and Max Wait to at least one poll, even given 0', async () => {
		const { router, polls } = polling('pending', () => ok({ run: runPayload({ status: 'succeeded' }) }));
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 0, pollEvery: 0 });

		expect(polls()).toBe(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		expect(result.ms).toBeGreaterThanOrEqual(1900);
	});

	it('a 429 on the poll without Retry-After waits another Poll Every, then succeeds', async () => {
		const { router, polls } = polling('processing', (n) =>
			n === 1 ? failure(429, 'generic', 'Too Many Attempts.') : ok({ run: runPayload({ status: 'succeeded' }) }),
		);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 10, pollEvery: 2 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls()).toBe(2);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		// 2 s before the first poll, 2 s of Poll Every after the 429.
		expect(result.ms).toBeGreaterThanOrEqual(3900);
	});

	it('a 429 on the poll with Retry-After: 1 waits that second instead', async () => {
		const { router, polls } = polling('processing', (n) =>
			n === 1
				? { ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '1' } }
				: ok({ run: runPayload({ status: 'succeeded' }) }),
		);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 10, pollEvery: 3 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls()).toBe(2);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		// 3 s before the first poll, then the 1 s Retry-After (4 s) rather than another 3 s of Poll Every (6 s).
		expect(result.ms).toBeGreaterThanOrEqual(3900);
		expect(result.ms).toBeLessThan(5400);
	});

	it('a 429 on the poll with Retry-After: 0 is retried no faster than once a second', async () => {
		const { router, polls } = polling('processing', (n) =>
			n <= 3
				? { ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '0' } }
				: ok({ run: runPayload({ status: 'succeeded' }) }),
		);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 20, pollEvery: 2 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls()).toBe(4);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
		// 2 s before the first poll, then three 429s each followed by the 1 s floor. With no floor the
		// run is over at about 2 s; one wait of Poll Every instead of the floor would reach 7 s.
		expect(result.ms).toBeGreaterThanOrEqual(4900);
		expect(result.ms).toBeLessThan(6500);
	});
});
