/**
 * The harness guards that keep the other engine tests honest: n8n drops a top-level key that no
 * longer matches a property, without an error, so a test that still set one of the optional
 * fields there would run on the defaults and prove nothing.
 */
import { describe, expect, it } from 'vitest';

import { emit, OPTION_NAMES, runAsTool, runTemplate, runWorkflow, s2d, s2dConnected, s2dDescription, type TestNode } from './harness';

const run = (node: TestNode) => runWorkflow({ baseUrl: 'http://127.0.0.1:1', nodes: [emit([{ json: {} }]), node], connections: [['Emit', 'SourceToDocs']] });

it('guards every name of the Options collections, and no others', () => {
	const inCollections = s2dDescription.properties
		.filter((property) => property.name === 'options')
		.flatMap((property) => (property.options as Array<{ name: string }>).map((item) => item.name));

	expect([...OPTION_NAMES].sort()).toEqual([...new Set(inCollections)].sort());
});

describe('s2d', () => {
	it("keeps its don't-wait default under options, and merges the caller's options over it", () => {
		expect(s2d({}).parameters.options).toEqual({ waitForCompletion: false });
		expect(s2dConnected({ options: { idempotencyKey: 'k' } }).parameters.options).toEqual({ waitForCompletion: false, idempotencyKey: 'k' });
		expect(s2d({ options: { waitForCompletion: true, maxWait: 5 } }).parameters.options).toEqual({ waitForCompletion: true, maxWait: 5 });
	});

	it('puts none of the optional fields at the top level', () => {
		expect(Object.keys(s2dConnected({ options: { pollEvery: 2 } }).parameters)).not.toEqual(expect.arrayContaining(['waitForCompletion']));
	});
});

describe.each([...OPTION_NAMES])('a test that sets %s at the top level', (name) => {
	const value = name === 'distributionIds' ? [] : name === 'additionalDataSets' ? {} : name === 'idempotencyKey' || name === 'unknownKeys' ? 'drop' : true;

	it('is refused by runWorkflow', async () => {
		await expect(run(s2dConnected({ [name]: value }))).rejects.toThrow(`${name} at the top level`);
	});

	it('is refused by runAsTool', async () => {
		const node: TestNode = { ...s2dConnected({ [name]: value }), type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocsTool' };
		await expect(runAsTool({ baseUrl: 'http://127.0.0.1:1', node, calls: [{}] })).rejects.toThrow(`${name} at the top level`);
	});

	it('is refused by runTemplate, through what pick returns', async () => {
		await expect(
			runTemplate('one-invoice-per-customer.json', { baseUrl: 'http://127.0.0.1:1', fixtures: {}, pick: (params) => ({ ...params, [name]: value }) }),
		).rejects.toThrow(`${name} at the top level`);
	});
});

describe('the guard leaves other nodes and the options collection alone', () => {
	it('lets a node that is not SourceToDocs carry a field of that name', async () => {
		const other: TestNode = { name: 'SourceToDocs', type: 'test.emit', parameters: { items: '[]', maxWait: 1 } };
		await expect(run(other)).resolves.toBeDefined();
	});
});
