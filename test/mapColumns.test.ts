import { describe, expect, it } from 'vitest';

import { documentFields } from '../nodes/SourceToDocs/descriptions/DocumentDescription';
import { methods } from '../nodes/SourceToDocs/methods';

// getColumns itself runs on the engine: test-engine/test/methods.engine.test.ts.
describe('the Columns parameter', () => {
	it('is registered under the name the Columns parameter points at', () => {
		const columns = documentFields.find((field) => field.name === 'columns');
		expect(columns?.typeOptions?.resourceMapper?.resourceMapperMethod).toBe('getColumns');
		expect(typeof methods.resourceMapping.getColumns).toBe('function');
	});

	it('is a resource mapper of columns with a clear message for no fields, and auto-map', () => {
		const columns = documentFields.find((field) => field.name === 'columns');
		const options = columns?.typeOptions?.resourceMapper;

		expect(columns?.type).toBe('resourceMapper');
		expect(options).toMatchObject({
			mode: 'add',
			fieldWords: { singular: 'column', plural: 'columns' },
			addAllFields: true,
			supportAutoMap: true,
		});
		expect(options?.noFieldsError).toMatch(/document/i);
		expect(columns?.typeOptions?.loadOptionsDependsOn).toEqual(['documentId.value', 'mappedDataSetId']);
		expect(columns?.displayOptions?.show?.rowsFrom).toEqual(['mapped']);
	});
});

describe('Rows Come From', () => {
	const rowsFrom = documentFields.find((field) => field.name === 'rowsFrom');
	const values = (rowsFrom?.options as Array<{ value: string; name: string }>).map((o) => o.value);

	it('keeps connected as the default and workflow as the JSON value, and adds mapped', () => {
		expect(rowsFrom?.default).toBe('connected');
		expect(values).toEqual(['connected', 'workflow', 'mapped']);
		const names = Object.fromEntries(
			(rowsFrom?.options as Array<{ value: string; name: string }>).map((o) => [o.value, o.name]),
		);
		expect(names.workflow).toMatch(/JSON/);
		expect(names.mapped).toMatch(/Map Columns/);
	});

	it('shows Data Set and Columns in Map Columns mode only', () => {
		for (const name of ['mappedDataSetId', 'columns']) {
			const field = documentFields.find((candidate) => candidate.name === name);
			expect(field?.displayOptions?.show?.rowsFrom).toEqual(['mapped']);
		}
		for (const name of ['unknownKeys', 'additionalDataSets']) {
			expect(documentFields.filter((field) => field.name === name)).toEqual([]);
		}
	});
});
