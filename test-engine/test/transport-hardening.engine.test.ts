/**
 * The transport's limits: https only, no redirects, timeouts, and a credential only
 * this node can use. Each case runs through n8n's own engine against real local HTTP servers.
 *
 * The 30 s request timeout is shortened through `transportLimits` (a test-only knob) so the
 * cases that wait for it take seconds.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
	HTTP_REQUEST_TYPE,
	S2D_TYPE,
	documentPayload,
	callMethod,
	emit,
	ok,
	runPayload,
	runWorkflow,
	s2d,
	s2dConnected,
	transportLimits,
	useFakeApis,
	type FakeApi,
	type Router,
} from './harness';

const startApi = useFakeApis();
const projects = () => s2d({ resource: 'project', operation: 'getMany' });
const readProjects = (baseUrl: string) =>
	runWorkflow({ baseUrl, nodes: [emit([{ json: {} }]), projects()], connections: [['Emit', 'SourceToDocs']] });

interface ErrorCopy {
	name: string;
	message: string;
	description?: string;
	context: Record<string, unknown>;
}

const NEVER = { status: 0 } as const;

describe('Base URL must be https', () => {
	/** The fake API, reached through a name the rule does not know: `localhost.` (trailing dot) is the same machine. */
	const nonLocalSpelling = (api: FakeApi) => api.baseUrl.replace('127.0.0.1', 'localhost.');

	it.each([
		['a plain http host that is not local', (api: FakeApi) => nonLocalSpelling(api)],
		['another scheme', (api: FakeApi) => api.baseUrl.replace('http://', 'ftp://')],
		['something that is not a URL', () => 'app.sourcetodocs.com/api/public/v1'],
	])('refuses %s before any request, naming Base URL', async (_title, baseUrlOf) => {
		const api = await startApi(() => ok({ projects: [] }));

		const result = await readProjects(baseUrlOf(api));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toContain('Base URL');
		expect(api.requests).toHaveLength(0);
	});

	it('says why in the description: the token goes with every request', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		const result = await readProjects(nonLocalSpelling(api));

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.message).toContain('must use https');
		expect(error.description).toMatch(/'API Token' is sent/);
	});

	it.each([
		['127.0.0.1', (api: FakeApi) => api.baseUrl],
		['localhost', (api: FakeApi) => api.baseUrl.replace('127.0.0.1', 'localhost')],
	])('still works over plain http to %s', async (_title, baseUrlOf) => {
		const api = await startApi(() => ok({ projects: [{ id: 'a0000000-0000-4000-8000-000000000001' }] }));

		const result = await readProjects(baseUrlOf(api));

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([{ id: 'a0000000-0000-4000-8000-000000000001' }]);
		expect(api.requests).toHaveLength(1);
	});

	it('covers a Generate: nothing is read or created', async () => {
		const api = await startApi(() => ok({}));

		const result = await runWorkflow({
			baseUrl: nonLocalSpelling(api),
			nodes: [emit([{ json: {} }]), s2dConnected()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect((result.errorOf('SourceToDocs') as unknown as ErrorCopy).message).toContain('Base URL');
		expect(api.requests).toHaveLength(0);
	});

	it.each([
		['load options', 'loadOptions', 'getProjects', { resource: 'document' }],
		['list search', 'listSearch', 'searchDocuments', { projectId: 'a0000000-0000-4000-8000-000000000001' }],
	] as const)('covers %s', async (_title, kind, name, parameters) => {
		const api = await startApi(() => ok({ projects: [], documents: [] }));

		await expect(
			callMethod({ kind, name, parameters, baseUrl: nonLocalSpelling(api) }),
		).rejects.toThrow(/Base URL/);
		expect(api.requests).toHaveLength(0);
	});
});

describe('a redirect is not followed', () => {
	async function redirecting(status: number, location: (target: FakeApi) => string) {
		const target = await startApi(() => ok({ projects: [] }));
		const source = await startApi(() => ({ status, headers: { location: location(target) } }));
		return { target, source };
	}

	it.each([301, 302, 307, 308])('a %i to another server: it receives nothing and the error names the redirect', async (status) => {
		const { target, source } = await redirecting(status, (t) => `${t.origin}/api/public/v1/projects`);

		const result = await readProjects(source.baseUrl);

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy & { httpCode?: string };
		expect(target.requests).toHaveLength(0);
		expect(source.requests).toHaveLength(1);
		expect(error.name).toBe('NodeApiError');
		expect(error.httpCode).toBe(String(status));
		expect(error.message).toContain(`HTTP ${status}`);
		expect(error.message).toContain(new URL(target.origin).host);
		expect(error.description).toContain("Set 'Base URL'");
		expect(error.description).toContain('/api/public/v1');
	});

	it('a relative Location is reported as another path on the same host', async () => {
		const source = await startApi(() => ({ status: 302, headers: { location: '/login' } }));

		const result = await readProjects(source.baseUrl);

		expect((result.errorOf('SourceToDocs') as unknown as ErrorCopy).message).toContain('another path on the same host');
	});

	it('a redirect to the same server is not followed either, and the token goes out once', async () => {
		const source = await startApi((request) =>
			request.path.endsWith('/projects')
				? { status: 302, headers: { location: `${request.path}/` } }
				: ok({ projects: [] }),
		);

		const result = await readProjects(source.baseUrl);

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		expect(source.requests).toHaveLength(1);
	});

	it('a POST that is redirected is an error too, and its body goes nowhere else', async () => {
		const target = await startApi(() => ok({}));
		const source = await startApi(() => ({ status: 307, headers: { location: `${target.origin}/x` } }));

		const result = await runWorkflow({
			baseUrl: source.baseUrl,
			nodes: [emit([{ json: {} }]), s2dConnected()],
			connections: [['Emit', 'SourceToDocs']],
		});

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		expect(target.requests).toHaveLength(0);
	});
});

describe('a request that is never answered', () => {
	const originalTimeout = transportLimits.requestTimeoutMs;
	afterEach(() => {
		transportLimits.requestTimeoutMs = originalTimeout;
	});

	it('has a 30 s timeout unless a test shortens it', () => {
		expect(originalTimeout).toBe(30_000);
	});

	it('a read ends with the timeout error', async () => {
		transportLimits.requestTimeoutMs = 1000;
		const api = await startApi(() => NEVER);

		const result = await readProjects(api.baseUrl);

		const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
		expect(error.name).toBe('NodeApiError');
		expect(error.message).toBe('The SourceToDocs API did not answer within 1 second');
		expect(result.ms).toBeGreaterThanOrEqual(900);
		expect(result.ms).toBeLessThan(4000);
	});

	it('the start POST that is never answered is tried 3 times with one key, then ends with the timeout error', async () => {
		transportLimits.requestTimeoutMs = 1000;
		const originalBackoff = transportLimits.startRetryBackoffMs;
		transportLimits.startRetryBackoffMs = 50;
		try {
			const api = await startApi((request) => (request.method === 'POST' ? NEVER : ok(documentPayload.data)));

			const result = await runWorkflow({
				baseUrl: api.baseUrl,
				nodes: [emit([{ json: {} }]), s2dConnected()],
				connections: [['Emit', 'SourceToDocs']],
			});

			const error = result.errorOf('SourceToDocs') as unknown as ErrorCopy;
			expect(error.message).toBe('The SourceToDocs API did not answer within 1 second');
			expect(api.posts()).toHaveLength(3);
			expect(new Set(api.posts().map((post) => (post.body as { idempotency_key: string }).idempotency_key)).size).toBe(1);
			expect(result.ms).toBeGreaterThanOrEqual(3100);
			expect(result.ms).toBeLessThan(5000);
		} finally {
			transportLimits.startRetryBackoffMs = originalBackoff;
		}
	});
});

describe('waiting for a run that stops answering', () => {
	const originalTimeout = transportLimits.requestTimeoutMs;
	afterEach(() => {
		transportLimits.requestTimeoutMs = originalTimeout;
	});

	/** The POST creates a pending run; the polls follow `onPoll(n)`. */
	function polling(onPoll: (pollNumber: number) => ReturnType<Router>): { router: Router; polls: () => number } {
		let polls = 0;
		return {
			polls: () => polls,
			router: (request) => {
				if (request.method === 'POST') return ok({ run: runPayload({ status: 'pending' }) }, 201);
				polls += 1;
				return onPoll(polls);
			},
		};
	}

	const generate = (api: FakeApi, parameters: Record<string, unknown>) =>
		runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), s2dConnected({ waitForCompletion: true, ...parameters })],
			connections: [['Emit', 'SourceToDocs']],
		});

	it('a poll the server never answers ends within Max Wait plus the timeout, as a timed-out item', async () => {
		transportLimits.requestTimeoutMs = 1000;
		const { router, polls } = polling(() => NEVER);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 2, pollEvery: 2 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.json('SourceToDocs')).toEqual([
			expect.objectContaining({ run_id: 'b0000000-0000-4000-8000-000000000001', timed_out: true }),
		]);
		expect(polls()).toBe(1);
		expect(result.ms).toBeGreaterThanOrEqual(2900);
		expect(result.ms).toBeLessThan(2000 + 1000 + 1500);
	});

	it('a poll timeout is retried while Max Wait lasts', async () => {
		transportLimits.requestTimeoutMs = 1000;
		const { router, polls } = polling((n) =>
			n === 1 ? NEVER : ok({ run: runPayload({ status: 'succeeded', output_result: { document_url: 'https://docs.google.com/d/1', document_name: 'Invoice' } }) }),
		);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 8, pollEvery: 2 });

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(polls()).toBe(2);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ status: 'succeeded' });
	});

	it('polls that never answer end the wait within Max Wait plus one timeout', async () => {
		transportLimits.requestTimeoutMs = 1000;
		const { router, polls } = polling(() => NEVER);
		const api = await startApi(router);

		const result = await generate(api, { maxWait: 6, pollEvery: 2 });

		expect(result.json('SourceToDocs')[0]).toMatchObject({ timed_out: true });
		expect(polls()).toBeGreaterThanOrEqual(2);
		expect(result.ms).toBeLessThan(6000 + 1000 + 1500);
	});
});

describe('the credential belongs to this node', () => {
	it('the node itself and its AI tool variant may use it', async () => {
		for (const type of [S2D_TYPE, `${S2D_TYPE}Tool`]) {
			const api = await startApi(() => ok({ projects: [{ id: 'a0000000-0000-4000-8000-000000000001' }] }));
			const node = { ...projects(), type, credentials: { sourceToDocsApi: { id: 'cred-1', name: 'SourceToDocs account' } } };

			const result = await runWorkflow({ baseUrl: api.baseUrl, nodes: [emit([{ json: {} }]), node], connections: [['Emit', 'SourceToDocs']] });

			expect(result.errorOf('SourceToDocs')).toBeUndefined();
			expect(result.json('SourceToDocs')).toEqual([{ id: 'a0000000-0000-4000-8000-000000000001' }]);
		}
	});

	it('the HTTP Request node is refused the credential, and nothing goes on the wire', async () => {
		const api = await startApi(() => ok({ projects: [] }));

		const result = await runWorkflow({
			baseUrl: api.baseUrl,
			nodes: [emit([{ json: {} }]), { name: 'HTTP Request', type: HTTP_REQUEST_TYPE, parameters: { url: `${api.origin}/anything` } }],
			connections: [['Emit', 'HTTP Request']],
		});

		const error = result.errorOf('HTTP Request') as unknown as ErrorCopy;
		expect(error.message).toContain('restricted to specific nodes');
		expect(api.requests).toHaveLength(0);
	});
});
