import type { INodeProperties } from 'n8n-workflow';

import { DOCUMENT_OUTPUT, RUN_OUTPUT, type OutputProfile } from '../output';

const FIELDS_LINK = '<a href="https://docs.n8n.io/code/expressions/">expression</a>';

/** The Fields parameter of a run operation; Document → Get overrides what differs. */
const runFieldsProperty: INodeProperties = {
	displayName: 'Fields',
	name: 'outputFields',
	type: 'multiOptions',
	default: ['run_id', 'status', 'file_url'],
	options: RUN_OUTPUT.fields.map((field) => ({ name: field, value: field })),
	description: `The fields to keep. 'run_id' (and 'batch_run_id' on a batch's files), 'timed_out', 'idempotent_replay' and the 'Map Columns' notes ('dropped_keys', 'empty_columns', 'empty_rows', 'missing_split_keys') are always kept when they apply. Choose from the list, or specify the field names using an ${FIELDS_LINK}.`,
};

const documentFieldsOverrides: Partial<INodeProperties> = {
	default: DOCUMENT_OUTPUT.defaultFields,
	options: DOCUMENT_OUTPUT.fields.map((field) => ({ name: field, value: field })),
	description: `The fields to keep. 'id' is always kept. Choose from the list, or specify the field names using an ${FIELDS_LINK}.`,
};

/**
 * Output and Fields, for an operation that returns flattened runs or a Document (node version 1.1
 * and later). Version 1 keeps its Simplify boolean on the run operations, shown only below 1.1.
 */
export function outputProperties(
	resource: string,
	operation: string,
	profile: OutputProfile = RUN_OUTPUT,
): INodeProperties[] {
	const show = {
		resource: [resource],
		operation: [operation],
		'@version': [{ _cnd: { gte: 1.1 } }],
	};
	const isRun = profile === RUN_OUTPUT;
	return [
		{
			displayName: 'Output',
			name: 'output',
			type: 'options',
			default: 'simplified',
			displayOptions: { show },
			options: [
				{
					name: 'Simplified',
					value: 'simplified',
					description: isRun
						? 'The ten fields most workflows read (status, file_url, file_name, split_key, file_count, deliveries, warnings and the error), without the full run object'
						: "The document's name, type, project, split and PDF settings, its Data Sets as a name and a list of column names, and its Distributions as an ID, a label and whether they are enabled",
				},
				{
					name: 'Raw',
					value: 'raw',
					description: isRun
						? 'The flattened fields, plus the complete run as the API returned it, under run'
						: 'The document exactly as the API returned it',
				},
				{
					name: 'Selected Fields',
					value: 'selected',
					description: 'Only the fields you pick below',
				},
			],
			description: isRun ? 'How much of each run to return' : 'How much of the document to return',
		},
		{
			...runFieldsProperty,
			...(isRun ? {} : documentFieldsOverrides),
			displayOptions: { show: { ...show, output: ['selected'] } },
		},
	];
}

/** Return All and Limit for a Get Many (node version 1.1 and later); version 1 returns everything, as it always did. */
export function getManyLimitProperties(resource: string): INodeProperties[] {
	const show = {
		resource: [resource],
		operation: ['getMany'],
		'@version': [{ _cnd: { gte: 1.1 } }],
	};
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: true,
			displayOptions: { show },
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			displayOptions: { show: { ...show, returnAll: [false] } },
			description: 'Max number of results to return',
			hint: 'The API has no paging: this cuts the list it returned.',
		},
	];
}
