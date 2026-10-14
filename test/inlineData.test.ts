import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	dropUnknownKeys,
	inlineDataFrom,
	parseDataSetEntries,
	setOwn,
	type DataSetEntry,
} from '../nodes/SourceToDocs/inlineData';

const DS1 = '11111111-2222-4333-8444-555555555555';
const DS2 = '22222222-3333-4444-8555-666666666666';

const node: INode = {
	id: 'node-1',
	name: 'SourceToDocs',
	type: '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** `inline_data` from the Data Sets collection, no key policy applied: what Generate builds before Unknown Fields. */
const buildInlineData = (node: INode, entries: DataSetEntry[]) =>
	inlineDataFrom(
		parseDataSetEntries(node, entries).map(({ dataSetId, rows }) => [dataSetId, rows] as const),
	);

describe('buildInlineData', () => {
	it('keys the rows by data set id, one array per entry', () => {
		const inlineData = buildInlineData(node, [
			{ dataSetId: DS1, rows: [{ Name: 'Acme' }, { Name: 'Globex' }] },
			{ dataSetId: DS2, rows: [{ Line: 1 }] },
		]);

		expect(inlineData).toEqual({
			[DS1]: [{ Name: 'Acme' }, { Name: 'Globex' }],
			[DS2]: [{ Line: 1 }],
		});
	});

	it('returns an empty object for an empty collection', () => {
		expect(buildInlineData(node, [])).toEqual({});
	});

	it('parses a JSON string into rows', () => {
		const inlineData = buildInlineData(node, [
			{ dataSetId: DS1, rows: '[{"Name":"Acme"}]' },
		]);

		expect(inlineData).toEqual({ [DS1]: [{ Name: 'Acme' }] });
	});

	it('treats a blank string as no rows', () => {
		expect(buildInlineData(node, [{ dataSetId: DS1, rows: '   ' }])).toEqual({ [DS1]: [] });
	});

	it('refuses invalid JSON, naming the entry, before building anything', () => {
		expect(() => buildInlineData(node, [{ dataSetId: DS1, rows: '{not json' }])).toThrow(
			NodeOperationError,
		);
		expect(() => buildInlineData(node, [{ dataSetId: DS1, rows: '{not json' }])).toThrow(
			/'Rows' of entry 1 in 'Data Sets' is not valid JSON/,
		);
	});

	it('refuses a Rows value that is not an array, naming the entry', () => {
		expect(() =>
			buildInlineData(node, [{ dataSetId: DS1, rows: { Name: 'Acme' } }]),
		).toThrow(/'Rows' of entry 1 in 'Data Sets' must be a JSON array of objects/);
	});

	it('refuses a row inside the array that is not a plain object', () => {
		expect(() =>
			buildInlineData(node, [{ dataSetId: DS1, rows: [{ Name: 'Acme' }, 'not an object'] }]),
		).toThrow(/Row 1 of .Rows. in entry 1 of .Data Sets. is not a plain object/);
	});

	it('refuses an entry with no data set selected', () => {
		expect(() => buildInlineData(node, [{ dataSetId: '', rows: [] }])).toThrow(
			/Entry 1 in 'Data Sets' has no 'Data Set' selected/,
		);
	});

	it('refuses the same data set picked twice', () => {
		expect(() =>
			buildInlineData(node, [
				{ dataSetId: DS1, rows: [] },
				{ dataSetId: DS1, rows: [{ Name: 'Acme' }] },
			]),
		).toThrow(/Entry 2 in 'Data Sets' picks the same 'Data Set'/);
	});

	it('stops at the first bad entry: no inline data for any entry when one is invalid', () => {
		let error: unknown;
		try {
			buildInlineData(node, [
				{ dataSetId: DS1, rows: [{ Name: 'Acme' }] },
				{ dataSetId: DS2, rows: 'not json either' },
			]);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NodeOperationError);
	});
});

describe('inline_data construction never reaches a prototype setter', () => {
	it('setOwn stores __proto__ as a key and leaves the prototype alone', () => {
		const target: Record<string, unknown> = {};

		setOwn(target, '__proto__', [{ a: 1 }]);

		expect(Object.keys(target)).toEqual(['__proto__']);
		expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
		expect(JSON.stringify(target)).toBe('{"__proto__":[{"a":1}]}');
	});

	it('inlineDataFrom keeps a __proto__ Data Set id with its rows', () => {
		const inlineData = inlineDataFrom([['__proto__', [{ a: 1 }]], [DS1, []]]);

		expect(JSON.stringify(inlineData)).toBe(`{"__proto__":[{"a":1}],"${DS1}":[]}`);
		expect(Object.getPrototypeOf(inlineData)).toBe(Object.prototype);
	});

	it('dropUnknownKeys keeps a __proto__ Data Set id, its rows and its dropped keys', () => {
		const rows = [{ keep: 1, extra: 2 }];

		const known = dropUnknownKeys([{ dataSetId: '__proto__', rows }], new Map([['__proto__', new Set(['keep'])]]));
		const unknown = dropUnknownKeys([{ dataSetId: '__proto__', rows }], new Map());

		expect(JSON.stringify(known.inlineData)).toBe('{"__proto__":[{"keep":1}]}');
		expect(JSON.stringify(known.droppedKeys)).toBe('{"__proto__":["extra"]}');
		expect(JSON.stringify(unknown.inlineData)).toBe('{"__proto__":[{"keep":1,"extra":2}]}');
	});

	it('dropUnknownKeys keeps a __proto__ column as a column', () => {
		const row = JSON.parse('{"__proto__": 1, "x": 2}') as Record<string, unknown>;

		const { inlineData } = dropUnknownKeys([{ dataSetId: DS1, rows: [row] as never }], new Map([[DS1, new Set(['__proto__'])]]));

		expect(JSON.stringify(inlineData)).toBe(`{"${DS1}":[{"__proto__":1}]}`);
	});

	it('buildInlineData refuses a __proto__ Data Set id', () => {
		expect(() => buildInlineData(node, [{ dataSetId: '__proto__', rows: [] }])).toThrow(/.Data Set. is not a valid ID: "__proto__"/);
	});
});

describe('dropUnknownKeys, a Data Set with no listed column', () => {
	it('leaves the rows untouched and reports nothing dropped', () => {
		const rows = [{ a: 1, b: 2 }];

		const { inlineData, droppedKeys } = dropUnknownKeys([{ dataSetId: DS1, rows }], new Map([[DS1, new Set<string>()]]));

		expect(inlineData).toEqual({ [DS1]: [{ a: 1, b: 2 }] });
		expect(droppedKeys).toEqual({});
	});

	it('still drops against a Data Set that lists columns', () => {
		const { inlineData, droppedKeys } = dropUnknownKeys([{ dataSetId: DS1, rows: [{ a: 1, b: 2 }] }], new Map([[DS1, new Set(['a'])]]));

		expect(inlineData).toEqual({ [DS1]: [{ a: 1 }] });
		expect(droppedKeys).toEqual({ [DS1]: ['b'] });
	});
});
