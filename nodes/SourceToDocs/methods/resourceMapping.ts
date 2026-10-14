import type {
	FieldType,
	ILoadOptionsFunctions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

import type { PublicColumnData, PublicColumnType } from '../types';
import { currentDocument } from './document';

/**
 * The widget a column's type picks in the mapper. The type guides the input only: whatever the
 * mapping holds is sent as it comes, and the API stays the judge of what a row may hold.
 *
 * `number` and `bool` are strings too (measured on n8n 2.36.9): the editor seeds an untouched
 * `number` field with `0` and a `boolean` field with `false`, which then render as a real 0 or
 * "No" in the document. A string field stays out of the stored mapping until it is filled in, so
 * an untouched column sends nothing. `date` is left alone: the editor already stores no key for it.
 *
 * A `select` column whose choices the API publishes is an `options` field instead (see `getColumns`);
 * without choices it stays a free-text string.
 */
const FIELD_TYPE_BY_COLUMN_TYPE: Record<PublicColumnType, FieldType> = {
	text: 'string',
	number: 'string',
	bool: 'string',
	date: 'dateTime',
	select: 'string',
	file: 'string',
	relation: 'string',
};

/** A select column's published choices, or `undefined` for free text (no list, an empty list, or not a select). */
function choicesOf(column: PublicColumnData): string[] | undefined {
	if (column.type !== 'select' || !Array.isArray(column.choices) || column.choices.length === 0) {
		return undefined;
	}
	return column.choices;
}

function fieldTypeOf(columnType: string): FieldType {
	return FIELD_TYPE_BY_COLUMN_TYPE[columnType as PublicColumnType] ?? 'string';
}

/**
 * The mapped Data Set's columns as mapper fields, in the order `GET /documents/{id}` lists them.
 *
 * A column the Data Set selects is shown; an unselected one is present but `removed` (hidden
 * until the person adds it from the mapper's "add column" list) because the API accepts any
 * column of the Table. A Data Set that selects no column renders every column, so then none is
 * `removed`. With no Document or Data Set picked yet there is nothing to map: an empty list,
 * for which the parameter's `noFieldsError` speaks.
 */
export async function getColumns(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const dataSetId = (this.getNodeParameter('mappedDataSetId', '') as string) ?? '';
	if (dataSetId === '') {
		return { fields: [] };
	}

	const document = await currentDocument(this);
	const dataSet = document?.data_sets.find((candidate) => candidate.id === dataSetId);
	if (dataSet === undefined) {
		return { fields: [] };
	}

	const noneSelected = !dataSet.columns.some((column: PublicColumnData) => column.selected);

	const fields: ResourceMapperField[] = dataSet.columns.map((column) => {
		const choices = choicesOf(column);
		return {
			id: column.name,
			displayName: column.name,
			required: false,
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			// The options widget only offers the list. Generate sends what the mapping resolves, so an
			// expression is sent as it is; n8n itself refuses a literal outside the list before the run.
			...(choices !== undefined
				? { type: 'options' as const, options: choices.map((name) => ({ name, value: name })) }
				: { type: fieldTypeOf(column.type) }),
			removed: noneSelected ? false : !column.selected,
		};
	});

	return { fields };
}
