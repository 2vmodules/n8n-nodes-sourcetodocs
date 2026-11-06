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
					"Get a run started by Document → Generate: its status, its file and its deliveries. A batch also lists its children, one item per file, unless 'Summary Only' is on.",
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
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: {
			show: {
				resource: ['run'],
				operation: ['get'],
			},
		},
		options: [
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
						'@version': [{ _cnd: { gte: 1.1 } }],
					},
					hide: {
						summaryOnly: [true],
					},
				},
				description:
					"How long to keep retrying a batch's file list while the API is busy, before giving up. Not used for a single run or for 'Summary Only'.",
			},
			{
				displayName: 'Summary Only',
				name: 'summaryOnly',
				type: 'boolean',
				default: false,
				description:
					'Whether to return a batch run as a single summary item instead of listing its children. Has no effect on an ordinary (non-batch) run, which is always one item.',
			},
		],
	},
];
