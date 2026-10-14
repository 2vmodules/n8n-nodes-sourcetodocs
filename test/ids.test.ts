import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { assertId, assertIds, idForPath } from '../nodes/SourceToDocs/ids';

const node: INode = {
	id: 'node-1',
	name: 'SourceToDocs',
	type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const UUID = '9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6';

describe('assertId', () => {
	it('returns a UUID trimmed, in the case it came', () => {
		expect(assertId(node, 'Document', ` ${UUID.toUpperCase()}\n`)).toBe(UUID.toUpperCase());
	});

	it.each([
		'',
		'abc',
		`${UUID}/children`,
		`../${UUID}`,
		`${UUID}?x=1`,
		`${UUID}#f`,
		'__proto__',
		'9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4eg',
		`${UUID}${UUID}`,
		null,
		undefined,
		42,
		{ id: UUID },
		[UUID],
	])('refuses %j with a NodeOperationError naming the parameter', (value) => {
		const attempt = () => assertId(node, 'Run ID', value);

		expect(attempt).toThrow(NodeOperationError);
		expect(attempt).toThrow(/^'Run ID' is not a valid ID: /);
	});

	it('quotes a string value and cuts it at 40 characters', () => {
		expect(() => assertId(node, 'Project', 'a'.repeat(100))).toThrow(`'Project' is not a valid ID: "${'a'.repeat(40)}..."`);
		expect(() => assertId(node, 'Project', 'abc')).toThrow("'Project' is not a valid ID: \"abc\"");
	});
});

describe('idForPath', () => {
	it('is the validated id, URL-encoded', () => {
		expect(idForPath(node, 'Document', UUID)).toBe(UUID);
	});

	it('refuses what is not an id instead of encoding it', () => {
		expect(() => idForPath(node, 'Document', '../../projects#')).toThrow(/^'Document' is not a valid ID/);
	});
});

describe('assertIds', () => {
	it('returns the list with every id validated', () => {
		expect(assertIds(node, 'Deliver To', [UUID, ` ${UUID} `])).toEqual([UUID, UUID]);
		expect(assertIds(node, 'Deliver To', [])).toEqual([]);
	});

	it('refuses the whole list for one bad id', () => {
		expect(() => assertIds(node, 'Deliver To', [UUID, 'x/y'])).toThrow("'Deliver To' is not a valid ID: \"x/y\"");
	});

	it('refuses a value that is not a list', () => {
		expect(() => assertIds(node, 'Deliver To', UUID)).toThrow(/^'Deliver To' must be a list of IDs/);
	});
});
