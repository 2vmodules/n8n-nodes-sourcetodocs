/**
 * The transport (how the node talks to the Public API), through n8n's own engine: what goes on
 * the wire, and how each kind of answer becomes a node error. Moved from the stubbed transport
 * tests; the same envelope-mapping cases, now arriving over a real HTTP connection.
 *
 * Every case reads through Project → Get Many because it needs nothing else.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	TOKEN,
	emit,
	failure,
	ok,
	runWorkflow,
	s2d,
	useFakeApis,
	type FakeApi,
	type FakeReply,
} from './harness';

const TROUBLESHOOTING = 'https://app.sourcetodocs.com/docs/guides/troubleshooting/';

const startApi = useFakeApis();

interface ErrorCopy {
	name: string;
	message: string;
	description?: string;
	httpCode?: string;
	context: Record<string, unknown>;
}

async function projectsFrom(api: FakeApi, baseUrl = api.baseUrl) {
	return await runWorkflow({
		baseUrl,
		nodes: [emit([{ json: {} }]), s2d({ resource: 'project', operation: 'getMany' })],
		connections: [['Emit', 'SourceToDocs']],
	});
}

async function errorOfAnswer(reply: FakeReply, headers?: Record<string, string>): Promise<ErrorCopy> {
	const api = await startApi(() => ({ ...reply, headers: { ...reply.headers, ...headers } }));
	const result = await projectsFrom(api);
	const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy | undefined;
	if (error === undefined) throw new Error('expected the node to fail');
	return error;
}

const html = (status: number, raw: string): FakeReply => ({ status, raw, headers: { 'content-type': 'text/html' } });

describe('the request', () => {
	it('is an authenticated JSON GET to the Base URL joined with the endpoint, and returns the data', async () => {
		const api = await startApi(() => ok({ projects: [{ id: 'a0000000-0000-4000-8000-000000000001' }] }));

		const result = await projectsFrom(api);

		expect(result.json('SourceToDocs')).toEqual([{ id: 'a0000000-0000-4000-8000-000000000001' }]);
		expect(api.requests).toHaveLength(1);
		expect(api.requests[0]).toMatchObject({ method: 'GET', path: `${API_PATH}/projects`, body: undefined });
		expect(api.requests[0].headers.accept).toContain('application/json');
		expect(api.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it.each([
		['one trailing slash', '/'],
		['two trailing slashes', '//'],
	])('joins with exactly one slash when the Base URL ends with %s', async (_title, tail) => {
		const api = await startApi(() => ok({ projects: [] }));

		await projectsFrom(api, `${api.baseUrl}${tail}`);

		expect(api.requests[0].path).toBe(`${API_PATH}/projects`);
	});

	it('ignores spaces around the Base URL', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		await projectsFrom(api, ` ${api.baseUrl} `);

		expect(api.requests[0].path).toBe(`${API_PATH}/projects`);
	});

	it('refuses to send anything when the credential has no Base URL', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		const result = await projectsFrom(api, '   ');

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toContain("no 'Base URL'");
		expect(api.requests).toHaveLength(0);
	});

	it('sends a Generate body as JSON', async () => {
		const api = await startApi(() => ok({ run: { id: 'r-1', status: 'pending', kind: 'single', distributions: [] } }, 201));

		await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [
				emit([{ json: {} }]),
				s2d({ rowsFrom: 'connected', idempotencyKey: 'key-9' }, { name: 'SourceToDocs' }),
			],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(api.posts()).toHaveLength(1);
		expect(api.posts()[0].headers['content-type']).toContain('application/json');
		expect(api.posts()[0].body).toEqual({ idempotency_key: 'key-9' });
	});
});

describe('an answer that is an envelope', () => {
	it('becomes a NodeApiError with the API message, errors.code, category and HTTP code (a 422)', async () => {
		const error = await errorOfAnswer(
			failure(422, 'validation', 'The document does not belong to this workspace.', { code: ['workspace_mismatch'] }),
		);

		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('The document does not belong to this workspace.');
		expect(error.description).toBe(`Code: workspace_mismatch. Category: validation. See ${TROUBLESHOOTING}#workspace_mismatch for what this code means and how to fix it`);
		expect(error.httpCode).toBe('422');
	});

	it('lists the context a refusal carries next to its code, without repeating the code', async () => {
		const error = await errorOfAnswer(
			failure(422, 'plan', 'The plan limit for runs has been reached.', {
				code: ['plan.limit_exceeded.runs'],
				metric: 'runs',
				limit: 100,
				used: 100,
			}),
		);

		expect(error.message).toBe('The plan limit for runs has been reached.');
		expect(error.description).toBe(
			`Code: plan.limit_exceeded.runs. Category: plan. metric: runs. limit: 100. used: 100. See ${TROUBLESHOOTING}#planlimit_exceededruns for what this code means and how to fix it`,
		);
	});

	it('maps a 401 whose errors are empty to the auth category alone', async () => {
		const error = await errorOfAnswer(failure(401, 'auth', 'Invalid API token.'));

		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('Invalid API token.');
		expect(error.description).toBe("Category: auth. Check that the 'API Token' of the SourceToDocs credential is correct and has not been revoked");
		expect(error.httpCode).toBe('401');
	});

	it('reads errors.code given as a plain string', async () => {
		const error = await errorOfAnswer(
			failure(422, 'conflict', 'A run with this idempotency key exists.', { code: 'run_idempotency_conflict' }),
		);

		expect(error.description).toContain('Code: run_idempotency_conflict');
		expect(error.description).toContain('Category: conflict');
	});

	it('lists field errors of a validation envelope after the code and category', async () => {
		const error = await errorOfAnswer(
			failure(422, 'validation', 'The given data was invalid.', {
				inline_data: ['The inline data field must be an object.'],
				'distribution_ids.0': ['must be a valid UUID', 'must exist'],
			}),
		);

		expect(error.message).toBe('The given data was invalid.');
		expect(error.description).toBe(
			'Category: validation. inline_data: The inline data field must be an object. distribution_ids.0: must be a valid UUID; must exist. Correct the fields listed above, then run the node again',
		);
	});

	it('answers promptly when a 422 echoes a 200 000 character unknown key, and routes like any other 422', async () => {
		const key = `${'.'.repeat(200_000)}x`;
		const api = await startApi(() =>
			failure(422, 'validation', 'Unknown columns.', { code: ['inline_column_unknown'], unknown_keys: [key] }),
		);

		const started = Date.now();
		const result = await projectsFrom(api);
		const tookMs = Date.now() - started;

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.httpCode).toBe('422');
		expect(error.message).toBe('Unknown columns.');
		expect(error.description).toContain('Code: inline_column_unknown');
		expect(error.description!.length).toBeLessThan(2000);
		expect(tookMs).toBeLessThan(5000);
	});

	it('names the rate limit on a 429', async () => {
		const error = await errorOfAnswer(failure(429, 'generic', 'Too Many Attempts.'));

		expect(error.message).toBe('Too Many Attempts.');
		expect(error.description).toContain('60 requests a minute');
		expect(error.httpCode).toBe('429');
	});

	it('omits the category from the description when the envelope has none', async () => {
		const error = await errorOfAnswer({ status: 422, body: { success: false, message: 'Refused.', errors: { code: ['some_code'] } } });

		expect(error.description).toBe(`Code: some_code. See ${TROUBLESHOOTING}#some_code for what this code means and how to fix it`);
	});

	it('rejects a 2xx envelope whose success is false', async () => {
		const error = await errorOfAnswer({ status: 200, body: { success: false, category: 'generic', message: 'Nope.', errors: [] } });

		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('Nope.');
		expect(error.description).toMatch(/^Category: generic\. Try again shortly/);
	});

	it('falls back to a message naming the status when the envelope has none', async () => {
		const error = await errorOfAnswer({ status: 500, body: { success: false, category: 'generic', errors: [] } });

		expect(error.message).toBe('The SourceToDocs API answered HTTP 500');
	});
});

describe('an answer that is not an envelope', () => {
	it('rejects HTML even on a 200, and points at the Base URL', async () => {
		const error = await errorOfAnswer(html(200, '<html>Sign in</html>'));

		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('The SourceToDocs API answered HTTP 200 without its JSON envelope');
		expect(error.description).toContain('Base URL');
		expect(error.httpCode).toBe('200');
	});

	it('names the 40 MB limit on a 413 and does not blame the Base URL', async () => {
		const error = await errorOfAnswer({ status: 413, raw: 'Payload too large', headers: { 'content-type': 'text/plain' } });

		expect(error.message).toContain('413');
		expect(error.message).toContain('over its limit');
		expect(error.description).toContain('40 MB');
		expect(error.description).not.toContain('Base URL');
		expect(error.httpCode).toBe('413');
	});

	it.each([502, 503, 504])('says the API is unreachable on a %s HTML page', async (status) => {
		const error = await errorOfAnswer(html(status, 'Bad Gateway'));

		expect(error.message).toContain(String(status));
		expect(error.message).toContain('unreachable');
		expect(error.description).not.toContain('Base URL');
	});

	it('still blames the Base URL for a 404 HTML page', async () => {
		const error = await errorOfAnswer(html(404, '<html>Not found</html>'));

		expect(error.description).toContain('Base URL');
	});
});

describe('Retry-After on a failure, as the node reads it off the wire', () => {
	const tooMany = failure(429, 'generic', 'Too Many Attempts.');
	const retryAfterMs = async (header: string | undefined) =>
		(await errorOfAnswer(tooMany, header === undefined ? undefined : { 'retry-after': header })).context.retryAfterMs;

	it.each([
		['a number of seconds', '2', 2000],
		['zero', '0', 0],
		['a fraction', '1.5', 1500],
	])('%s becomes milliseconds on the error context', async (_title, header, ms) => {
		expect(await retryAfterMs(header)).toBe(ms);
	});

	it('is read when the header name is capitalised (n8n lower-cases it on arrival)', async () => {
		const api = await startApi(() => ({ ...tooMany, headers: { 'Retry-After': '3' } }));
		const result = await projectsFrom(api);

		expect((result.errorOf('SourceToDocs') as unknown as ErrorCopy).context.retryAfterMs).toBe(3000);
	});

	it.each([
		['absent', undefined],
		['negative', '-5'],
		['garbage', 'soon'],
		['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
	])('leaves retryAfterMs unset when the header is %s', async (_title, header) => {
		expect(await retryAfterMs(header)).toBeUndefined();
	});
});
