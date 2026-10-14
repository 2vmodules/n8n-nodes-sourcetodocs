import type { INodeProperties } from 'n8n-workflow';

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
			'The data set these rows belong to — pick it to see its column names. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'json',
		default: '',
		description:
			"A JSON array of objects, one per row, with each object's fields matching the data set's column names exactly — not its alias, not an ID. Pick the Data Set above to see its columns, or call Document → Get first. A column a row omits renders null. A field that is not one of the data set's columns is handled by 'Unknown Fields' below.",
		hint: "All input items: {{ $input.all().map(i => i.json) }} · An array field of the items: {{ $input.all().flatMap(i => i.json.Lines) }} · Another node's items: {{ $('Get lines').all().map(i => i.json) }}",
	},
];

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
					"Start a run that renders the document into a file — a Google Slides deck, a Google Docs document, or a PDF — from its connected data sources or from rows supplied in this workflow, and return the produced file's link. Use Document → Get first to learn the document's data sets and their column names if rows are coming from this workflow.",
				action: 'Generate document',
			},
			{
				name: 'Get',
				value: 'get',
				description:
					"Get one document: its data sets (each with its column names — the exact keys a row for Document → Generate's Rows must use), its split configuration, and its distributions",
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
		displayName: 'Project Name or ID',
		name: 'projectId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getProjects',
		},
		default: '',
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['get', 'generate'],
			},
		},
		description:
			'A project, to filter the Document picker below by. Only used to build that list: the Document below is what is read or generated, and which project it belongs to is never sent. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Document',
		name: 'documentId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['projectId'],
		},
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['get', 'generate'],
			},
		},
		description:
			"The document to generate or read. A document is a template that renders rows into Google Slides, Google Docs or a PDF: Generate starts a run of it and returns the produced file's link, Get reads its data sets (with their column names) and its distributions. Only the document itself matters here — the project above is only how the From List mode is filtered",
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
					"Send rows from this workflow for one or more of the document's data sets, as a JSON array you write or an expression you build — rows from another node, or from an array inside an item — in place of reading them from their connected source",
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
			"One row is sent per incoming item. The columns the data set selects in SourceToDocs are shown; any other column of its table can be added from the list. 'Map Each Column Manually' sends exactly the values you map; 'Map Automatically' sends each item's own fields, and 'Unknown Fields' below decides what happens to a field that is not a column.",
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
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['mapped'],
			},
		},
		description:
			'Rows for other data sets of the document, as JSON — for rows that come from another node or from an array inside an item. The data set mapped above may not appear here. Each data set may appear once; a data set left out is still read from its connected source.',
		options: [
			{
				displayName: 'Data Set',
				name: 'values',
				values: dataSetEntryFields,
			},
		],
	},
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
					"Remove, from every row, any field that is not one of that row's Data Set's own columns, and report the removed field names on the output as dropped_keys. A misspelled field is still visible — the run still starts.",
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
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['workflow'],
			},
		},
		description:
			"What to do with a row field that is not one of its Data Set's own columns. Most sources add their own fields to every item they produce — an Airtable read carries ID and createdTime, an n8n Form submission carries submittedAt and formMode — on top of the ones you actually picked, so 'Drop' is on by default. Pick 'Refuse' to see the API's own refusal instead of having fields silently removed.",
		hint: "Most sources add their own fields to every item (Airtable's ID/createdTime, the Form Trigger's submittedAt/formMode). 'Drop' removes anything that is not a column, 'Refuse' sends rows as given",
	},
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
				resource: ['document'],
				operation: ['generate'],
				rowsFrom: ['mapped'],
			},
		},
		description:
			"What to do with a row field that is not one of its Data Set's own columns. It applies when the columns above are set to Map Automatically — an Airtable read carries ID and createdTime, an n8n Form submission carries submittedAt and formMode, on top of the fields you care about — and to the rows of Additional Data Sets. Map Each Column Manually sends only the columns you mapped, so there is nothing for it to remove there.",
		hint: 'Only applies to Map Automatically and to Additional Data Sets',
	},
	{
		displayName: 'Deliver To Names or IDs',
		name: 'distributionIds',
		type: 'multiOptions',
		typeOptions: {
			loadOptionsMethod: 'getDistributions',
			loadOptionsDependsOn: ['documentId.value'],
		},
		default: [],
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
			},
		},
		description:
			'The document\'s enabled distributions to deliver this run\'s file to. Leave empty to deliver to all enabled distributions. Not available for a split-configured document — it delivers through its own distributions instead, and this list shows a notice rather than a choice. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		hint: 'Sent as distribution_ids; leaving it empty is the same as omitting distribution_ids from the Public API',
	},
	{
		displayName: 'Wait For Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
			},
		},
		description:
			"Whether to poll the run until it finishes (or 'Max Wait (Seconds)' elapses) and return its file. Turned off, the node returns as soon as the run is created, with its starting status — poll it later with Run → Get.",
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
				resource: ['document'],
				operation: ['generate'],
				waitForCompletion: [true],
			},
		},
		description:
			"How long to keep polling before giving up. A run still going when this elapses does not stop the workflow: the item comes back with 'timed_out: true' and the run's ID to poll later. 'Max Wait (Seconds)' is at least 'Poll Every (Seconds)'; both are capped at 3600 s.",
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
			show: {
				resource: ['document'],
				operation: ['generate'],
				waitForCompletion: [true],
			},
		},
		description:
			"How often to check the run while waiting. 12 polls a minute sits well under the 60-requests-a-minute token limit. 'Poll Every (Seconds)' is at least 2 s; both it and 'Max Wait (Seconds)' are capped at 3600 s, and 'Max Wait (Seconds)' is at least 'Poll Every (Seconds)'.",
	},
	{
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['generate'],
			},
		},
		description:
			"Optional. Leave empty and the node sends its own key, the same on every 'Retry On Fail' try of this node run and different for every run and every execution, so a retry resumes the run it started instead of making a second (as an AI tool the key comes from the request, so two identical calls in one execution share one run). The automatic key adopts only a run created in the last 6 hours. A key you set is sent as it is, and a repeat of it resumes the run that holds it (the output says 'idempotent_replay: true'). A run that ended with status 'failed' is not resumed, whether or not it made its document: the retry starts one new run under the key followed by ':after:' and that run's ID, for your own key too. A key resumes the run that holds it whatever its rows, so when an AI agent fills it, build it from the execution's ID and the model's value: a key the model picks alone can return another call's run",
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
	...getManyLimitProperties('document'),
];
