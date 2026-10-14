import type { INodeProperties } from 'n8n-workflow';

import { getManyLimitProperties } from './OutputDescription';

export const projectOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['project'],
			},
		},
		options: [
			{
				name: 'Get Many',
				value: 'getMany',
				description:
					'List every project in the workspace. A project is a folder of documents; take its ID to Document → Get Many to list the documents inside it.',
				action: 'Get many projects',
			},
		],
		default: 'getMany',
	},
];

export const projectFields: INodeProperties[] = [...getManyLimitProperties('project')];
