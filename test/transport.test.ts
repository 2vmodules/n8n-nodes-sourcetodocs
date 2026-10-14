import type { INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	assertSecureBaseUrl,
	isRequestTimeout,
	joinUrl,
	transportLimits,
	unwrapEnvelope,
} from '../nodes/SourceToDocs/transport';

const node: INode = {
	id: 'node-1',
	name: 'SourceToDocs',
	type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const PRODUCTION = 'https://app.sourcetodocs.com/api/public/v1';

// The request itself (auth, URL join, errors over a real connection) runs on the engine:
// test-engine/test/transport.engine.test.ts. What stays is plain functions of an INode literal.

describe('unwrapEnvelope', () => {
	it('returns data from a success envelope', () => {
		expect(unwrapEnvelope(node, 200, { success: true, data: { document: { id: 'd-1' } } })).toEqual(
			{ document: { id: 'd-1' } },
		);
	});

	it('reads errors.code given as a plain string', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 422, {
				success: false,
				category: 'conflict',
				message: 'A run with this idempotency key exists.',
				errors: { code: 'run_idempotency_conflict' },
			}),
		) as NodeApiError;

		expect(error.description).toContain('Code: run_idempotency_conflict');
		expect(error.description).toContain('Category: conflict');
	});

	it('lists field errors of a validation envelope after the code and category', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 422, {
				success: false,
				category: 'validation',
				message: 'The given data was invalid.',
				errors: {
					inline_data: ['The inline data field must be an object.'],
					'distribution_ids.0': ['must be a valid UUID', 'must exist'],
				},
			}),
		) as NodeApiError;

		expect(error.message).toBe('The given data was invalid.');
		expect(error.description).toBe(
			'Category: validation. inline_data: The inline data field must be an object. distribution_ids.0: must be a valid UUID; must exist. Correct the fields listed above, then run the node again',
		);
	});

	it('names the rate limit on a 429', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 429, {
				success: false,
				category: 'generic',
				message: 'Too Many Attempts.',
				errors: [],
			}),
		) as NodeApiError;

		expect(error.message).toBe('Too Many Attempts.');
		expect(error.description).toContain('60 requests a minute');
		expect(error.httpCode).toBe('429');
	});

	it('rejects a body that is not the envelope, even on a 2xx', () => {
		const error = catching(() => unwrapEnvelope(node, 200, '<html>Sign in</html>')) as NodeApiError;

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('The SourceToDocs API answered HTTP 200 without its JSON envelope');
		expect(error.description).toContain('Base URL');
		expect(error.httpCode).toBe('200');
	});

	it('rejects a 2xx envelope whose success is false', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 200, {
				success: false,
				category: 'generic',
				message: 'Nope.',
				errors: [],
			}),
		) as NodeApiError;

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('Nope.');
		expect(error.description).toMatch(/^Category: generic\. Try again shortly/);
	});

	it('falls back to a message naming the status when the envelope has none', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 500, { success: false, category: 'generic', errors: [] }),
		) as NodeApiError;

		expect(error.message).toBe('The SourceToDocs API answered HTTP 500');
	});

	// An envelope-less answer is mapped by status, not always blamed on the Base URL.
	it('names the 40 MB limit on a 413 with no envelope', () => {
		const error = catching(() => unwrapEnvelope(node, 413, 'Payload too large')) as NodeApiError;

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toContain('413');
		expect(error.message).toContain('over its limit');
		expect(error.description).toContain('40 MB');
		expect(error.description).not.toContain('Base URL');
		expect(error.httpCode).toBe('413');
	});

	it.each([502, 503, 504])('says the API is unreachable on a %s with no envelope', (statusCode) => {
		const error = catching(() => unwrapEnvelope(node, statusCode, 'Bad Gateway')) as NodeApiError;

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toContain(String(statusCode));
		expect(error.message).toContain('unreachable');
		expect(error.description).not.toContain('Base URL');
	});

	it('still blames the Base URL for a 404/HTML answer with no envelope', () => {
		const error = catching(() => unwrapEnvelope(node, 404, '<html>Not found</html>')) as NodeApiError;

		expect(error.description).toContain('Base URL');
	});

	it("stashes a Retry-After header's seconds, as milliseconds, on the error's context", () => {
		const error = catching(() =>
			unwrapEnvelope(
				node,
				429,
				{ success: false, category: 'generic', message: 'Too Many Attempts.', errors: [] },
				{ 'retry-after': '2' },
			),
		) as NodeApiError;

		expect(error.context.retryAfterMs).toBe(2000);
	});

	// A header name reaches the node lower-cased from the engine's HTTP layer, so the capitalised
	// and numeric forms are only reachable here, with a literal headers object.
	it.each([
		['a capitalised name', { 'Retry-After': '3' }, 3000],
		['a number value', { 'retry-after': 4 }, 4000],
		['zero', { 'retry-after': '0' }, 0],
		['a negative number', { 'retry-after': '-1' }, undefined],
		['garbage', { 'retry-after': 'soon' }, undefined],
		['an array value', { 'retry-after': ['2'] }, undefined],
	])('reads Retry-After given as %s', (_title, headers, expected) => {
		const error = catching(() =>
			unwrapEnvelope(node, 429, { success: false, category: 'generic', message: 'x', errors: [] }, headers),
		) as NodeApiError;

		expect(error.context.retryAfterMs).toBe(expected);
	});

	it('leaves retryAfterMs unset when there is no Retry-After header', () => {
		const error = catching(() =>
			unwrapEnvelope(node, 429, {
				success: false,
				category: 'generic',
				message: 'Too Many Attempts.',
				errors: [],
			}),
		) as NodeApiError;

		expect(error.context.retryAfterMs).toBeUndefined();
	});
});

describe('joinUrl', () => {
	it('puts exactly one slash between the base URL and the endpoint', () => {
		expect(joinUrl(`${PRODUCTION}/`, '/projects')).toBe(`${PRODUCTION}/projects`);
		expect(joinUrl(`${PRODUCTION}//`, 'projects')).toBe(`${PRODUCTION}/projects`);
		expect(joinUrl(` ${PRODUCTION} `, 'runs/r-1/children')).toBe(`${PRODUCTION}/runs/r-1/children`);
	});
});

function catching(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected the call to throw');
}

describe('assertSecureBaseUrl', () => {
	it.each([
		['https://app.sourcetodocs.com/api/public/v1'],
		['HTTPS://app.sourcetodocs.com/api/public/v1'],
		['http://localhost:8000/api/public/v1'],
		['http://127.0.0.1:25427/api/public/v1'],
		['http://[::1]:8000/api/public/v1'],
	])('accepts %s', (baseUrl) => {
		expect(() => assertSecureBaseUrl(node, baseUrl)).not.toThrow();
	});

	it.each([
		['http://app.sourcetodocs.com/api/public/v1'],
		['http://localhost.evil.test/api/public/v1'],
		['http://127.0.0.1@evil.test/api/public/v1'],
		['http://127.0.0.2/api/public/v1'],
		['http://localhost./api/public/v1'],
		['ftp://app.sourcetodocs.com/api/public/v1'],
		['file:///etc/passwd'],
		['app.sourcetodocs.com/api/public/v1'],
		[''],
	])('refuses %j with a NodeOperationError naming Base URL', (baseUrl) => {
		const error = caught(() => assertSecureBaseUrl(node, baseUrl));

		expect(error.name).toBe('NodeOperationError');
		expect(error.message).toContain('Base URL');
	});
});

describe('a redirect answer', () => {
	it('names the status and the Location host and says to set Base URL to the API root', () => {
		const error = caught(() =>
			unwrapEnvelope(node, 301, '', { location: 'https://other.example/api/public/v1/projects' }),
		);

		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('The SourceToDocs API answered HTTP 301: a redirect to other.example');
		expect(error.description).toContain('API root');
		expect(error.description).toContain('/api/public/v1');
	});

	it('copes with no Location header at all', () => {
		const error = caught(() => unwrapEnvelope(node, 302, ''));

		expect(error.message).toBe('The SourceToDocs API answered HTTP 302: a redirect to another address');
	});

	it('does not swallow a 304 or a 3xx that carries an envelope', () => {
		const error = caught(() => unwrapEnvelope(node, 304, { success: true, data: {} }));

		expect(error.message).toContain('HTTP 304');
	});
});

describe('an error answer that echoes huge input', () => {
	const refuse = (errors: unknown, message = 'Unknown columns.') =>
		catching(() => unwrapEnvelope(node, 422, { success: false, category: 'validation', message, errors })) as NodeApiError;

	function timed<T>(fn: () => T): { value: T; ms: number } {
		const start = performance.now();
		const value = fn();
		return { value, ms: performance.now() - start };
	}

	it('formats a detail of 1 000 000 dots in under 50 ms, to a message of a few KB', () => {
		const dots = '.'.repeat(1_000_000);

		const { value, ms } = timed(() => refuse({ code: ['inline_column_unknown'], unknown_keys: [`${dots}x`] }));

		expect(ms).toBeLessThan(50);
		expect(value.description!.length).toBeLessThan(2000);
	});

	it('formats a run of dots with nothing after it in under 50 ms', () => {
		const { value, ms } = timed(() => refuse({ unknown_keys: ['.'.repeat(1_000_000)] }, '.'.repeat(1_000_000)));

		expect(ms).toBeLessThan(50);
		expect(value.message.length).toBeLessThan(2000);
	});

	it('names a bounded number of fields and says how many more there were, within 50 ms', () => {
		const errors = Object.fromEntries(Array.from({ length: 10_000 }, (_v, i) => [`field_${i}`, ['bad']]));

		const { value, ms } = timed(() => refuse(errors));

		expect(ms).toBeLessThan(50);
		expect(value.description).toContain('field_0: bad');
		expect(value.description).not.toContain('field_10:');
		expect(value.description).toContain('and 9990 more fields');
		expect(value.description!.length).toBeLessThan(2000);
	});

	it('names a bounded number of messages per field, and one key list of 10 000 entries', () => {
		const { value, ms } = timed(() =>
			refuse({ unknown_keys: Array.from({ length: 10_000 }, (_v, i) => `key_${i}`) }),
		);

		expect(ms).toBeLessThan(50);
		expect(value.description).toContain('key_9');
		expect(value.description).not.toContain('key_10;');
		expect(value.description).toContain('and 9990 more');
	});

	it('cuts a long message, code and category with an ellipsis', () => {
		const error = refuse({ code: ['c'.repeat(5000)] }, 'm'.repeat(5000));

		expect(error.message).toBe(`${'m'.repeat(500)}…`);
		expect(error.description).toContain(`Code: ${"c".repeat(500)}…`);
	});

	it('still strips the trailing full stop of a part, and only the trailing ones', () => {
		const error = refuse({ a: ['one... two...'] });

		expect(error.description).toMatch(/^Category: validation\. a: one\.\.\. two\. Correct the fields/);
	});
});

describe('the request timeout', () => {
	it('is 30 seconds', () => {
		expect(transportLimits.requestTimeoutMs).toBe(30_000);
	});

	it('is recognised on the error the transport raises, and only there', () => {
		const timeout = new NodeApiError(node, {}, { message: 'x' });
		timeout.context.timedOut = true;

		expect(isRequestTimeout(timeout)).toBe(true);
		expect(isRequestTimeout(new NodeApiError(node, {}, { message: 'x' }))).toBe(false);
		expect(isRequestTimeout(new Error('x'))).toBe(false);
	});
});

function caught(fn: () => unknown): Error & { description?: string | null } {
	return catching(fn) as Error & { description?: string | null };
}
