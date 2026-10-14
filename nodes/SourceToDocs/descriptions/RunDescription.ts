import type { INodeProperties } from 'n8n-workflow';

import { outputProperties } from './OutputDescription';

export const runOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['run'],
			},
		},
		options: [
			{
				name: 'Get',
				value: 'get',
				description:
					"Get a run started by Document → Generate: its status, its file and its deliveries. Poll this after Generate with 'Wait For Completion' off, or after a timeout, until 'status' is 'succeeded', 'failed', 'partial_success' or 'cancelled'. For a batch run (one file per driver value), this also lists its children — one item per file — unless 'Summary Only' is on",
				action: 'Get run',
			},
		],
		default: 'get',
	},
];

export const runFields: INodeProperties[] = [
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6',
		displayOptions: {
			show: {
				resource: ['run'],
				operation: ['get'],
			},
		},
		description:
			"The ID of the run to read — the run_id a Document → Generate item returned, or a run's own ID from a batch's children",
	},
	{
		displayName: 'Summary Only',
		name: 'summaryOnly',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				resource: ['run'],
				operation: ['get'],
			},
		},
		description:
			'Whether to return a batch run as a single summary item instead of listing its children. Has no effect on an ordinary (non-batch) run, which is always one item.',
	},
	{
		displayName: 'Max Wait (Seconds)',
		name: 'maxWait',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 300,
		displayOptions: {
			show: {
				resource: ['run'],
				operation: ['get'],
				summaryOnly: [false],
				'@version': [{ _cnd: { gte: 1.1 } }],
			},
		},
		description:
			"How long to keep trying when the API answers a batch's children list with a busy or temporary answer, before giving up. 'Max Wait (Seconds)' is at least 5 s, the 'Poll Every (Seconds)' default of Document → Generate, and is capped at 3600 s. It does not apply to a single run or to 'Summary Only'. Node version 1 always uses the 300 s default.",
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				resource: ['run'],
				operation: ['get'],
				'@version': [{ _cnd: { lt: 1.1 } }],
			},
		},
		description: 'Whether to return a simplified version of the response instead of the raw data',
	},
	...outputProperties('run', 'get'),
];
