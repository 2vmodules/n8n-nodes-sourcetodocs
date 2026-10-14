/**
 * The credential class on the real engine: its `authenticate` block puts `Bearer <token>` on the
 * wire, applied the way n8n's CLI applies it, and the token never reaches run data or a stored
 * error. The credential's own `test` request runs in n8n's CLI, which is not reachable
 * in-process; its shape is asserted in `test/credential.test.ts` (root suite), and its
 * `baseURL` expression is resolved here through the real expression engine.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	SourceToDocsApi,
	defaultRouter,
	emit,
	evalWithCredentials,
	failure,
	ok,
	runWorkflow,
	s2d,
	s2dConnected,
	useFakeApis,
	type Router,
} from './harness';

const startApi = useFakeApis();

const projects = () => s2d({ resource: 'project', operation: 'getMany' });

describe('authenticate', () => {
	it.each([
		['a read', projects(), () => ok({ projects: [] })],
		['a generate', s2dConnected(), defaultRouter()],
	] as const)('puts Bearer <token> on every request of %s', async (_title, node, router) => {
		const api = await startApi(router as Router);

		await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), node],
			connections: [['Emit', 'SourceToDocs']],
			token: 'wsk_another_token_value',
		});

		expect(api.requests.length).toBeGreaterThan(0);
		for (const request of api.requests) {
			expect(request.headers.authorization).toBe('Bearer wsk_another_token_value');
		}
	});

	it('sends the token of the credential the run is given, not a fixed one', async () => {
		const api = await startApi(() => ok({ projects: [] }));
		const run = (token: string) =>
			runWorkflow({
				baseUrl: api.baseUrl,
				nodes: [emit([{ json: {} }]), projects()],
				connections: [['Emit', 'SourceToDocs']],
				token,
			});

		await run('wsk_first');
		await run('wsk_second');

		expect(api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer wsk_first', 'Bearer wsk_second']);
	});

	it('resolves the header from the class itself: a token with expression-looking text is sent whole', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), projects()],
			connections: [['Emit', 'SourceToDocs']],
			token: 'wsk_{{ 1 + 1 }}_end',
		});

		expect(api.requests[0].headers.authorization).toBe('Bearer wsk_{{ 1 + 1 }}_end');
	});
});

describe('the token stays out of run data and stored errors', () => {
	const secret = 'wsk_must_never_be_stored_anywhere';
	const answers: Array<[string, Router]> = [
		['a success', () => ok({ projects: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Marketing' }] })],
		['a 401', () => failure(401, 'auth', 'Invalid API token.')],
		['a 500', () => failure(500, 'server', 'Server Error')],
		['an HTML 200', () => ({ status: 200, raw: '<html>Sign in</html>', headers: { 'content-type': 'text/html' } })],
		['a 429', () => ({ ...failure(429, 'generic', 'Too Many Attempts.'), headers: { 'retry-after': '1' } })],
	];

	it.each(answers)('after %s', async (_title, router) => {
		const api = await startApi(router);

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), projects()],
			connections: [['Emit', 'SourceToDocs']],
			token: secret,
		});

		expect(api.requests[0].headers.authorization).toBe(`Bearer ${secret}`);
		expect(JSON.stringify(result.run.data)).not.toContain(secret);
		expect(JSON.stringify(result.run)).not.toContain(secret);
	});

	it('after a refused connection', async () => {
		const result = await runWorkflow({
			baseUrl: 'http://127.0.0.1:9/api/public/v1',
			nodes: [emit([{ json: {} }]), projects()],
			connections: [['Emit', 'SourceToDocs']],
			token: secret,
		});

		expect(result.errorOf('SourceToDocs')?.name).toBe('NodeApiError');
		expect(JSON.stringify(result.run)).not.toContain(secret);
	});

	it('with Continue On Fail, in the error item', async () => {
		const api = await startApi(() => failure(401, 'auth', 'Invalid API token.'));

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), s2d({ resource: 'run', operation: 'get', runId: 'r-1' }, { onError: 'continueRegularOutput' })],
			connections: [['Emit', 'SourceToDocs']],
			token: secret,
		});

		expect(result.json('SourceToDocs')).toHaveLength(1);
		expect(JSON.stringify(result.run)).not.toContain(secret);
	});

	it('after a failed Generate run that names its run id', async () => {
		const api = await startApi(defaultRouter({ status: 'failed', error_code: 'render_failed', error_message: 'No.' }));

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [
				emit([{ json: {} }]),
				s2dConnected({ waitForCompletion: true, maxWait: 60, pollEvery: 5 }),
			],
			connections: [['Emit', 'SourceToDocs']],
			token: secret,
		});

		expect(result.errorOf('SourceToDocs')?.name).toBe('NodeOperationError');
		expect(api.posts()[0].path).toBe(`${API_PATH}/documents/${DOC_ID}/runs`);
		expect(JSON.stringify(result.run)).not.toContain(secret);
	});
});

describe('the credential test request', () => {
	const baseURL = (new SourceToDocsApi().test.request as { baseURL: string }).baseURL;

	it.each([
		['https://app.sourcetodocs.com/api/public/v1', 'https://app.sourcetodocs.com/api/public/v1'],
		['https://app.sourcetodocs.com/api/public/v1/', 'https://app.sourcetodocs.com/api/public/v1'],
		['https://x.test/api///', 'https://x.test/api'],
		['', ''],
	])('resolves its baseURL expression for %j to %j', (configured, resolved) => {
		expect(evalWithCredentials(baseURL, { apiToken: 'wsk_x', baseUrl: configured })).toBe(resolved);
	});
});
