import type { IAuthenticateGeneric } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { SourceToDocsApi } from '../credentials/SourceToDocsApi.credentials';

/**
 * The credential class as plain data. Nothing here builds an n8n functions object: the class is
 * instantiated and read. The `authenticate` block is proven on the wire in
 * `test-engine/test/credential.engine.test.ts`; the `test` request runs in n8n's CLI, so only
 * its shape (URL, method, rules) can be asserted in-process.
 */
describe('the credential class', () => {
	const credential = new SourceToDocsApi();

	it('is named sourceToDocsApi, the name the node asks for', () => {
		expect(credential.name).toBe('sourceToDocsApi');
	});

	it('asks for an API Token (a password field) and a Base URL defaulting to production', () => {
		const byName = Object.fromEntries(credential.properties.map((property) => [property.name, property]));

		expect(Object.keys(byName)).toEqual(['apiToken', 'baseUrl']);
		expect(byName.apiToken).toMatchObject({ type: 'string', required: true, typeOptions: { password: true } });
		expect(byName.baseUrl).toMatchObject({
			type: 'string',
			required: true,
			default: 'https://app.sourcetodocs.com/api/public/v1',
		});
	});

	it('is restricted to the SourceToDocs node, so HTTP Request cannot use it', () => {
		expect(credential.restrictToSupportedNodes).toBe(true);
		expect(credential.supportedNodes).toEqual(['sourceToDocs']);
	});

	it('says in the Base URL description that it must be https and that the token is sent there', () => {
		const baseUrl = credential.properties.find((property) => property.name === 'baseUrl');

		expect(baseUrl?.description).toMatch(/https:\/\//);
		expect(baseUrl?.description).toMatch(/Test.*send the API Token to this address/s);
	});

	it('does not suggest a local or staging instance in the Base URL description: users only ever reach the production app', () => {
		const baseUrl = credential.properties.find((property) => property.name === 'baseUrl');

		expect(baseUrl?.description).not.toMatch(/localhost|staging|local (host|instance)/i);
	});

	it('authenticates generically with one Authorization header, Bearer plus the API Token', () => {
		const authenticate = credential.authenticate as IAuthenticateGeneric;

		expect(authenticate.type).toBe('generic');
		expect(authenticate.properties).toEqual({
			headers: { Authorization: '=Bearer {{$credentials.apiToken}}' },
		});
	});

	describe('the test request', () => {
		const test = credential.test;

		it('is GET /projects on the Base URL with its trailing slashes stripped', () => {
			expect(test.request.method).toBe('GET');
			expect(test.request.url).toBe('/projects');
			expect(test.request.baseURL).toBe('={{ ($credentials.baseUrl || "").replace(/\\/+$/, "") }}');
		});

		it('has the response-code rules 401, 404 and 429, then the envelope rule', () => {
			expect(test.rules?.map((rule) => [rule.type, (rule.properties as { value: number }).value])).toEqual([
				['responseCode', 401],
				['responseCode', 404],
				['responseCode', 429],
				['responseSuccessBody', undefined],
			]);
		});

		// n8n fails a responseSuccessBody rule when the body's `key` EQUALS `value` (n8n 2.37.9
		// credentials-tester.service.js:401-410). `undefined` therefore catches a 200 with no `success`.
		it('fails a 200 whose body has no `success`, the app\'s HTML page for one', () => {
			const rule = test.rules?.find((candidate) => candidate.type === 'responseSuccessBody');

			expect(rule?.properties).toMatchObject({ key: 'success', value: undefined });
			expect((rule?.properties as { message: string }).message).toMatch(/not the SourceToDocs Public API.*'Base URL'/s);
		});

		it.each([
			[401, /rejected the 'API Token'.*wsk_/s],
			[404, /'Base URL' \+ \/projects/],
			[429, /60 requests a minute/],
		])('words the %i rule so a reader knows what to do', (code, wording) => {
			const rule = test.rules?.find((candidate) => (candidate.properties as { value: number }).value === code);

			expect((rule?.properties as { message: string }).message).toMatch(wording);
		});
	});
});
