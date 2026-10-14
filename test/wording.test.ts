/**
 * The words of every message and description the node raises, per n8n's UX guidelines: no
 * "error", "failed", "failure" or "problem", the parameter named in single quotes, and a next
 * step in the description (a link to the docs, or the parameter to change). The paths that need
 * n8n's engine are in test-engine/test/wording.engine.test.ts.
 */
import type { INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { parseDataSetEntries } from '../nodes/SourceToDocs/inlineData';
import { assertId, assertIds } from '../nodes/SourceToDocs/ids';
import { readOutputChoice } from '../nodes/SourceToDocs/output';
import { resolveWaitOptions } from '../nodes/SourceToDocs/runs';
import { assertSecureBaseUrl, isAuthenticationRateLimit, unwrapEnvelope } from '../nodes/SourceToDocs/transport';

const node: INode = {
	id: 'node-1',
	name: 'SourceToDocs',
	type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs',
	typeVersion: 1.1,
	position: [0, 0],
	parameters: {},
};

const DOCS_LINK = /https:\/\/app\.sourcetodocs\.com\/docs\//;
const QUOTED_PARAMETER = /'[A-Z][^']*'/;

/** The avoided words, outside links and machine-readable names such as `error_code`. */
export function avoidedWordsIn(text: string): string[] {
	const prose = text.replace(/https?:\/\/\S+/g, '').replace(/\b\w+_\w+\b/g, '');
	return prose.match(/\b(errors?|fail(?:s|ed|ing|ures?)?|problems?)\b/gi) ?? [];
}

function raised(attempt: () => unknown): { message: string; description: string | undefined } {
	try {
		attempt();
	} catch (error) {
		expect(error).toSatisfy((e: unknown) => e instanceof NodeOperationError || e instanceof NodeApiError);
		const { message, description } = error as NodeOperationError;
		return { message, description: description ?? undefined };
	}
	throw new Error('nothing was raised');
}

function raisedError(attempt: () => unknown): unknown {
	try {
		attempt();
	} catch (error) {
		return error;
	}
	throw new Error('nothing was raised');
}

function expectWording(attempt: () => unknown, { link = false }: { link?: boolean } = {}) {
	const { message, description } = raised(attempt);
	expect(avoidedWordsIn(message), `message: ${message}`).toEqual([]);
	expect(description, `no description for: ${message}`).toBeTruthy();
	expect(avoidedWordsIn(description as string), `description: ${description}`).toEqual([]);
	expect(description as string, `no next step in: ${description}`).toMatch(link ? DOCS_LINK : new RegExp(`${DOCS_LINK.source}|${QUOTED_PARAMETER.source}|[Tt]ry again|Wait a minute|Correct the fields`));
	return { message, description: description as string };
}

const UUID = '9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6';

describe('the avoided words check', () => {
	it('sees prose and ignores links and machine-readable names', () => {
		expect(avoidedWordsIn('The run failed with an error')).toEqual(['failed', 'error']);
		expect(avoidedWordsIn('Code: render_failed. See https://x.test/run-error-codes/ for error_code')).toEqual([]);
	});
});

describe('API answers', () => {
	const envelope = (errors: unknown, category = 'validation', message = 'Refused.') => ({ success: false, category, message, errors });

	it.each([
		[400, envelope([])],
		[401, envelope([], 'authentication')],
		[403, envelope([], 'authorization')],
		[404, envelope([], 'not_found')],
		[422, envelope({ inline_data: ['must be an object'] })],
		[422, envelope({ code: ['inline_column_unknown'], unknown_keys: ['Foo'] })],
		[429, envelope([], 'rate_limit')],
		[500, envelope([], 'generic')],
	])('HTTP %i has a next step and none of the avoided words', (status, body) => {
		expectWording(() => unwrapEnvelope(node, status, body));
	});

	it.each([
		['a run code', 'render_timeout', '#render_timeout'],
		['a plan code', 'plan.limit_exceeded.generations', '#planlimit_exceededgenerations'],
		['a plan code of the subscription', 'plan.subscription_inactive', '#plansubscription_inactive'],
		['a split code', 'split_driver_rows_missing', '#split_driver_rows_missing'],
		['a delivery code', 'drive_delivery_failed', '#drive_delivery_failed'],
		['an upper-case code', 'Render_Timeout', '#render_timeout'],
	])('links the troubleshooting entry of the code when the answer carries %s', (_title, code, anchor) => {
		const { description } = expectWording(() => unwrapEnvelope(node, 422, envelope({ code: [code] })), { link: true });
		expect(description).toContain(`https://app.sourcetodocs.com/docs/guides/troubleshooting/${anchor}`);
		expect(description).not.toContain('/docs/reference/');
	});

	it('links the reference page, not a made-up anchor, for a code that is not a plain code name', () => {
		const { description } = expectWording(() => unwrapEnvelope(node, 422, envelope({ code: ['x y"><script>'] })), { link: true });
		expect(description).toContain('https://app.sourcetodocs.com/docs/reference/run-error-codes/');
		expect(description).not.toContain('troubleshooting/#');
	});

	it('source_too_large also tells a split document whose table is too big what to do', () => {
		const { description } = expectWording(() => unwrapEnvelope(node, 422, envelope({ code: ['source_too_large'] })), { link: true });
		expect(description).toMatch(/split document, its source table is too big/);
	});

	describe('authentication_rate_limited (a 429)', () => {
		const refused = () => unwrapEnvelope(node, 429, envelope({ code: ['authentication_rate_limited'] }, 'authentication', 'Too many attempts from this address.'));

		it('names the API Token to check, links its entry, and does not blame the per-token limit', () => {
			const { message, description } = expectWording(refused, { link: true });
			expect(message).toContain("'API Token'");
			expect(message).toContain('too many times');
			expect(description).toContain("Check that the 'API Token'");
			expect(description).toContain('does not retry');
			expect(description).toContain('/docs/guides/troubleshooting/#authentication_rate_limited');
			expect(description).not.toContain('60 requests a minute');
		});

		it("shows the API's own sentence after the node's, even when it uses a word the node avoids", () => {
			const { description } = raised(() => unwrapEnvelope(node, 429, envelope({ code: ['authentication_rate_limited'] }, 'authentication', 'Too many failed authentication attempts.')));
			expect(description).toContain('The API said: Too many failed authentication attempts');
		});

		it('is not a transient answer, while a 429 without the code still is', () => {
			expect(isAuthenticationRateLimit(raisedError(refused))).toBe(true);
			expect(isAuthenticationRateLimit(raisedError(() => unwrapEnvelope(node, 429, envelope([], 'generic', 'Too Many Attempts.'))))).toBe(false);
			expect(isAuthenticationRateLimit(raisedError(() => unwrapEnvelope(node, 429, 'Too many')))).toBe(false);
		});
	});

	it.each([
		[200, 'plain text'],
		[301, ''],
		[413, 'Payload too large'],
		[502, 'Bad gateway'],
		[404, '<html></html>'],
	])('an answer with no envelope (HTTP %i)', (status, body) => {
		expectWording(() => unwrapEnvelope(node, status, body));
	});

	it('a request body over the API limit (413, request_body_too_large) says what happened and how to get unstuck', () => {
		const { message, description } = expectWording(
			() => unwrapEnvelope(node, 413, envelope({ code: ['request_body_too_large'] }, 'validation', 'The request body is larger than 2 MB.')),
			{ link: true },
		);
		expect(message).toContain('too large');
		expect(message).toContain('2 MiB');
		expect(description).toContain('Code: request_body_too_large');
		expect(description).toMatch(/fewer rows per run/);
		expect(description).toMatch(/several runs/);
		expect(description).toContain('The API said: The request body is larger than 2 MB');
	});

	it('too many rows (422, source_too_large) says what happened and how to get unstuck', () => {
		const { message, description } = expectWording(
			() => unwrapEnvelope(node, 422, envelope({ code: ['source_too_large'], data_set_id: [UUID] }, 'validation', "inline_data for data set 'Lines' has more rows than the maximum allowed 100000.")),
			{ link: true },
		);
		expect(message).toContain('more rows than one run may hold');
		expect(description).toContain('Code: source_too_large');
		expect(description).toMatch(/fewer rows per run/);
		expect(description).toContain('Lines');
	});

	it('a body refused by the web server names both limits and the way out', () => {
		const { description } = expectWording(() => unwrapEnvelope(node, 413, 'Payload too large'), { link: true });
		expect(description).toMatch(/40 MB/);
		expect(description).toMatch(/2 MiB/);
		expect(description).toMatch(/fewer rows per run/);
	});
});

describe('the credential', () => {
	it.each(['not a url', 'http://example.test/api', 'ftp://example.test'])('refuses the Base URL %s, naming it', (baseUrl) => {
		const { message } = expectWording(() => assertSecureBaseUrl(node, baseUrl));
		expect(message).toContain("'Base URL'");
	});
});

describe('parameters the node checks itself', () => {
	it('an ID names its parameter in single quotes', () => {
		expect(expectWording(() => assertId(node, 'Run ID', 'x')).message).toMatch(/^'Run ID' is not a valid ID/);
		expect(expectWording(() => assertIds(node, 'Deliver To', 'x')).message).toMatch(/^'Deliver To' must be a list/);
	});

	it.each([
		['rows that are not JSON', [{ dataSetId: UUID, rows: '{nope' }]],
		['rows that are not an array', [{ dataSetId: UUID, rows: { a: 1 } }]],
		['a row that is not an object', [{ dataSetId: UUID, rows: [1] }]],
		['an entry with no Data Set', [{ dataSetId: '', rows: [] }]],
		['a Data Set picked twice', [{ dataSetId: UUID, rows: [] }, { dataSetId: UUID, rows: [] }]],
	])('Data Sets with %s', (_name, entries) => {
		expectWording(() => parseDataSetEntries(node, entries));
	});

	it('Additional Data Sets are named as such', () => {
		const { message } = expectWording(() => parseDataSetEntries(node, [{ dataSetId: '', rows: [] }], 'Additional Data Sets'));
		expect(message).toContain("'Additional Data Sets'");
	});

	it.each([['soon', undefined], [undefined, 'often'], [{}, undefined]])('Max Wait %j / Poll Every %j', (maxWait, pollEvery) => {
		const { message } = expectWording(() => resolveWaitOptions(node, maxWait, pollEvery));
		expect(message).toMatch(/^'(Max Wait|Poll Every) \(Seconds\)' is not a number/);
	});

	function outputContext(parameters: Record<string, unknown>) {
		return {
			getNode: () => node,
			getNodeParameter: (name: string, _index: number, fallback?: unknown) => parameters[name] ?? fallback,
		} as never;
	}

	it.each([
		['an output the node does not offer', { output: 'weird' }],
		['Selected Fields with no field', { output: 'selected', outputFields: [] }],
		['Selected Fields with an unknown field', { output: 'selected', outputFields: ['nope'] }],
	])('%s', (_name, parameters) => {
		expectWording(() => readOutputChoice(outputContext(parameters), 0));
	});
});
