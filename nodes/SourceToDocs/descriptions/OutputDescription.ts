import type { INodeProperties } from 'n8n-workflow';

import { SELECTABLE_FIELDS } from '../output';

/**
 * Output and Fields, for an operation that returns flattened runs (node version 1.1 and later).
 * Version 1 keeps its Simplify boolean, shown only below 1.1.
 */
export function outputProperties(resource: string, operation: string): INodeProperties[] {
	const show = {
		resource: [resource],
		operation: [operation],
		'@version': [{ _cnd: { gte: 1.1 } }],
	};
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
					description:
						'The flattened fields of each run (file_url, status, deliveries, warnings, generation_stats, folder_url and the rest), without the full run object',
				},
				{
					name: 'Raw',
					value: 'raw',
					description:
						'The flattened fields, plus the complete run as the API returned it, under run',
				},
				{
					name: 'Selected Fields',
					value: 'selected',
					description: 'Only the fields you pick below',
				},
			],
			description: 'How much of each run to return',
		},
		{
			displayName: 'Fields',
			name: 'outputFields',
			type: 'multiOptions',
			default: ['run_id', 'status', 'file_url'],
			displayOptions: { show: { ...show, output: ['selected'] } },
			options: SELECTABLE_FIELDS.map((field) => ({ name: field, value: field })),
			description:
				"The fields to keep. 'run_id' (and 'batch_run_id' on a batch's files), 'timed_out', 'idempotent_replay' and the 'Map Columns' notes ('dropped_keys', 'empty_columns', 'empty_rows', 'missing_split_keys') are always kept when they apply. Choose from the list, or specify the field names using an <a href=\"https://docs.n8n.io/code/expressions/\">expression</a>.",
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
