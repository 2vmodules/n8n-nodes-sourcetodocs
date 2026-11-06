import type { INodeProperties } from 'n8n-workflow';

import { DOCUMENT_OUTPUT } from '../output';
import { getManyLimitProperties, outputProperties } from './OutputDescription';
import { DOCUMENT_URL_REGEX, DOCUMENT_URL_VALIDATION_REGEX, UUID_REGEX } from './shared';

/** One Data Sets entry's fields — shared by the JSON mode's Data Sets and Map Columns' Additional Data Sets. */
const dataSetEntryFields: INodeProperties[] = [
	{
		displayName: 'Data Set Name or ID',
		name: 'dataSetId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getDataSets',
			loadOptionsDependsOn: ['documentId.value'],
		},
		default: '',
		description:
			'The data set these rows belong to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'json',
		default: '',
		description:
			"A JSON array of objects, one per row, with each object's keys matching the data set's column names exactly. A key that is not a column is handled by 'Unknown Fields' under Options.",
		hint: "All input items: {{ $input.all().map(i => i.json) }} · An array field of the items: {{ $input.all().flatMap(i => i.json.Lines) }} · Another node's items: {{ $('Get lines').all().map(i => i.json) }}",
	},
];

/** Options → Project: narrows the Document list to one project; the API never receives it. */
const projectFilterOption: INodeProperties = {
	displayName: 'Project Name or ID',
	name: 'projectId',
	type: 'options',
	typeOptions: {
		loadOptionsMethod: 'getProjects',
	},
	default: '',
	description:
		'Narrows the Document list above to one project, and is never sent to the API. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
};

export const documentOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['document'],
			},
		},
		options: [
			{
				name: 'Generate',
				value: 'generate',
				description:
					"Render the document into a Google Slides deck, a Google Docs document or a PDF, and return the file's link. One run starts for all input items, not one per item.",
				action: 'Generate document',
			},
			{
				name: 'Get',
				value: 'get',
				description:
					'Get one document: its data sets with their column names, whether it splits, and its distributions',
				action: 'Get document',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: "List the documents of a project, by the project's ID",
				action: 'Get many documents',
			},
		],
		default: 'generate',
	},
];

export const documentFields: INodeProperties[] = [
	{
		displayName: 'Project Name or ID',
		name: 'projectId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getProjects',
		},
		default: '',
		required: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['getMany'],
			},
		},
		description:
			'The project whose documents to list. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Document',
		name: 'documentId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['get', 'generate'],
			},
		},
		typeOptions: {
			loadOptionsDependsOn: ['options.projectId'],
		},
		description:
			'The document to generate or read. Pick it from the list, paste its URL, or enter its ID.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a document...',
				typeOptions: {
					searchListMethod: 'searchDocuments',
					searchable: true,
				},
			},
			{
				displayName: 'ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: UUID_REGEX,
							errorMessage: 'Not a valid document ID: expected a UUID',
						},
					},
				],
			},
			{
				displayName: 'By URL',
				name: 'url',
				type: 'string',
				placeholder:
					'https://app.sourcetodocs.com/documents/show/9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: DOCUMENT_URL_VALIDATION_REGEX,
							errorMessage: 'Not a SourceToDocs document URL: expected .../documents/show/<uuid>',
						},
					},
				],
				extractValue: {
					type: 'regex',
					regex: DOCUMENT_URL_REGEX,
				},
			},
		],
	},
	...outputProperties('document', 'get', DOCUMENT_OUTPUT),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['get'],
			},
		},
		options: [projectFilterOption],
	},
	{
		displayName: 'Rows Come From',
		name: 'rowsFrom',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Connected Data Sources',
				value: 'connected',
				description: "Read every data set from the document's own connected sources",
			},
			{
				name: 'This Workflow — JSON',
				value: 'workflow',
				description:
					"Send rows from this workflow for one or more of the document's data sets, as a JSON array, in place of reading them from their connected source",
			},
			{
				name: 'This Workflow — Map Columns',
				value: 'mapped',
				description:
					"Pick one of the document's data sets, map a value into each of its columns, and send one row per incoming item — no JSON to write",
			},
		],
		default: 'connected',
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
			},
		},
		description: "Where this run's rows come from",
	},
	{
		displayName: 'Data Sets',
		name: 'dataSets',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Data Set',
		default: {
			values: [{ dataSetId: '', rows: '={{ $input.all().map(i => i.json) }}' }],
		},
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['workflow'],
			},
		},
		description:
			"Rows to send for one or more of the document's data sets, in place of reading them live. Each data set may appear once; a data set left out here is still read from its connected source.",
		options: [
			{
				displayName: 'Data Set',
				name: 'values',
				values: dataSetEntryFields,
			},
		],
	},
	{
		displayName: 'Data Set Name or ID',
		name: 'mappedDataSetId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getDataSets',
			loadOptionsDependsOn: ['documentId.value'],
		},
		default: '',
		required: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['mapped'],
			},
		},
		description:
			'The data set to map: its columns appear below, and every incoming item becomes one of its rows. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Columns',
		name: 'columns',
		type: 'resourceMapper',
		noDataExpression: true,
		default: {
			mappingMode: 'defineBelow',
			value: null,
		},
		required: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['mapped'],
			},
		},
		description:
			"One row is sent per incoming item. 'Map Automatically' sends each item's own fields, and 'Unknown Fields' under Options decides what happens to a field that is not a column.",
		typeOptions: {
			loadOptionsDependsOn: ['documentId.value', 'mappedDataSetId'],
			resourceMapper: {
				resourceMapperMethod: 'getColumns',
				mode: 'add',
				fieldWords: {
					singular: 'column',
					plural: 'columns',
				},
				addAllFields: true,
				supportAutoMap: true,
				noFieldsError: 'Pick a document and one of its data sets above to see its columns',
				multiKeyMatch: false,
			},
		},
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
				'@version': [{ _cnd: { lt: 1.1 } }],
			},
		},
		description: 'Whether to return a simplified version of the response instead of the raw data',
	},
	...outputProperties('document', 'generate'),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
			},
		},
		options: [
			{
				displayName: 'Additional Data Sets',
				name: 'additionalDataSets',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Data Set',
				default: {},
				displayOptions: {
					show: {
						'/rowsFrom': ['mapped'],
					},
				},
				description:
					'Rows for other data sets of the document, as JSON, for example from another node. Each data set may appear once, and the one mapped above may not appear here.',
				options: [
					{
						displayName: 'Data Set',
						name: 'values',
						values: dataSetEntryFields,
					},
				],
			},
			{
				displayName: 'Deliver to Names or IDs',
				name: 'distributionIds',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getDistributions',
					loadOptionsDependsOn: ['documentId.value'],
				},
				default: [],
				description:
					'Leave empty to deliver to all enabled distributions. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					"Leave empty and the node sends its own key, so a 'Retry On Fail' try resumes the run instead of starting a second one. A key you set is sent as it is, and a repeat of it resumes the run that holds it.",
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
					hide: {
						waitForCompletion: [false],
					},
				},
				description:
					"How long to keep polling before giving up. A run still going then comes back with 'timed_out: true' and its ID, to poll later with Run → Get.",
			},
			{
				displayName: 'Poll Every (Seconds)',
				name: 'pollEvery',
				type: 'number',
				typeOptions: {
					minValue: 2,
				},
				default: 5,
				displayOptions: {
					hide: {
						waitForCompletion: [false],
					},
				},
				description: 'How often to check whether the run has finished',
			},
			projectFilterOption,
			{
				displayName: 'Unknown Fields',
				name: 'unknownKeys',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Drop',
						value: 'drop',
						description:
							"Remove, from every row, any field that is not one of that row's Data Set's own columns, and report the removed field names on the output as dropped_keys",
					},
					{
						name: 'Refuse',
						value: 'refuse',
						description:
							"Send every row exactly as given. A field that is not one of the Data Set's own columns is refused by the API, naming it.",
					},
				],
				default: 'drop',
				displayOptions: {
					show: {
						'/rowsFrom': ['workflow', 'mapped'],
					},
				},
				description:
					"What to do with a field that is not one of the Data Set's columns, such as the ID an Airtable read adds. With Map Columns it applies to Map Automatically and Additional Data Sets only.",
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				description:
					"Whether to poll the run until it finishes (or 'Max Wait (Seconds)' elapses) and return its file. Turned off, the node returns as soon as the run is created, with its starting status — poll it later with Run → Get.",
			},
		],
	},
	...getManyLimitProperties('document'),
];
