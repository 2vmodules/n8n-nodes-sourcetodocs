import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPairedItemData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { documentFields, documentOperations } from './descriptions/DocumentDescription';
import { projectFields, projectOperations } from './descriptions/ProjectDescription';
import { runFields, runOperations } from './descriptions/RunDescription';
import { methods as nodeMethods } from './methods';
import { executeDocumentGenerate } from './operations/generateDocument';
import {
	executeDocumentGet,
	executeDocumentGetMany,
	executeProjectGetMany,
	executeRunGet,
} from './operations/reads';
import { runIdNamedBy } from './startRun';
import { errorCodeFromErrors } from './transport';

type ReadExecutor = (
	context: IExecuteFunctions,
	itemIndex: number,
) => Promise<INodeExecutionData[]>;

const READ_EXECUTORS: Record<string, ReadExecutor> = {
	'project.getMany': executeProjectGetMany,
	'document.getMany': executeDocumentGetMany,
	'document.get': executeDocumentGet,
	'run.get': executeRunGet,
};

/**
 * A caught error, as the proper node error it should already be, or wrapped into one.
 *
 * A plain function, not a class method: `execute`'s `this` is explicitly typed
 * `IExecuteFunctions` (n8n calls it unbound from the class instance), so it never carries
 * instance methods.
 */
function asNodeError(
	node: INode,
	error: unknown,
	itemIndex?: number,
): NodeOperationError | NodeApiError {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) {
		// n8n shows "[Item N]" from `context.itemIndex`; the transport does not know the item.
		if (itemIndex !== undefined && error.context.itemIndex === undefined) {
			error.context.itemIndex = itemIndex;
		}
		return error;
	}
	return new NodeOperationError(node, error as Error, { itemIndex });
}

/** The shape of a failed `POST .../runs` envelope, as far as a `continueOnFail` item cares. */
interface ApiFailureEnvelope {
	category?: string;
	errors?: unknown;
}

/**
 * The facts a `continueOnFail` item should carry: the API's own `error_code`, `errors`
 * (field names such as `unknown_keys`, `data_set_id`, `table_id`) and `category` when the error
 * came from the transport's envelope, plus `run_id` whenever a Run was actually started — read
 * off `withRunId`'s `context.runId` (`runs.ts`), which every post-`201` error in
 * `generateDocument.ts` carries.
 */
function errorFacts(error: Error): IDataObject {
	const facts: IDataObject = {};

	if (error instanceof NodeApiError) {
		const envelope = error.errorResponse as ApiFailureEnvelope | undefined;
		if (typeof envelope?.category === 'string') {
			facts.category = envelope.category;
		}
		if (envelope?.errors !== undefined) {
			facts.errors = envelope.errors;
		}
		const code = errorCodeFromErrors(envelope?.errors);
		if (code !== undefined) {
			facts.error_code = code;
		}
	}

	if (error instanceof NodeOperationError || error instanceof NodeApiError) {
		const context = error.context;
		if (
			facts.error_code === undefined &&
			context.errorCode !== undefined &&
			context.errorCode !== null
		) {
			facts.error_code = context.errorCode;
		}
		if (typeof context.runId === 'string') {
			facts.run_id = context.runId;
		}
	}

	// An idempotency conflict the node could not adopt still says which run holds the key.
	if (facts.run_id === undefined && error instanceof NodeApiError) {
		const named = runIdNamedBy((error.errorResponse as ApiFailureEnvelope | undefined)?.errors);
		if (named !== undefined) {
			facts.run_id = named;
		}
	}

	return facts;
}

/** The failed-batch-children list a `batchFailureError` (`generateDocument.ts`) attached, if any. */
function failedChildrenOf(error: Error): IDataObject[] | undefined {
	if (!(error instanceof NodeOperationError || error instanceof NodeApiError)) {
		return undefined;
	}
	const failedChildren = error.context.failedChildren;
	return Array.isArray(failedChildren) ? (failedChildren as IDataObject[]) : undefined;
}

/**
 * The `continueOnFail` item(s) for a caught Generate error: one error item per failed child when
 * the error carries that list (a failed batch), else a single item carrying every fact
 * {@link errorFacts} can read off it. Every item pairs to every input item, matching
 * Generate's own successful items — one POST per execution, fanned across the whole input.
 */
function buildGenerateErrorItems(
	error: NodeOperationError | NodeApiError,
	pairedItem: IPairedItemData[],
	errorOutput: boolean,
): INodeExecutionData[] {
	const failedChildren = failedChildrenOf(error);
	if (failedChildren !== undefined && failedChildren.length > 0) {
		const batchRunId = errorFacts(error).run_id;
		return failedChildren.map((child) => ({
			json: errorJson(error.message, { batch_run_id: batchRunId, ...child }, errorOutput),
			pairedItem,
		}));
	}
	return [{ json: errorJson(error.message, errorFacts(error), errorOutput), pairedItem }];
}

/**
 * The json of a `continueOnFail` item. Never `item.error`: n8n then replaces the json with
 * `{ error: message }` and the facts are lost downstream.
 *
 * - Regular output (and the legacy `continueOnFail` flag): the flat shape, `error` plus the facts.
 * - Error output: only `error` and `details` keys. `handleNodeErrorOutput` routes an item to the
 *   error output when `json.error` is set and every json key is `error`, `message` or `details`.
 */
function errorJson(message: string, facts: IDataObject, errorOutput: boolean): IDataObject {
	return errorOutput ? { error: message, details: facts } : { error: message, ...facts };
}

export class SourceToDocs implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SourceToDocs',
		name: 'sourceToDocs',
		icon: { light: 'file:sourcetodocs.svg', dark: 'file:sourcetodocs.dark.svg' },
		group: ['transform'],
		version: [1, 1.1],
		defaultVersion: 1.1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Generate Google Slides, Google Docs and PDF documents from the rows in your workflow with SourceToDocs, and read your projects, documents and runs',
		defaults: {
			name: 'SourceToDocs',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sourceToDocsApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Document',
						value: 'document',
						description: 'A template that renders rows into Google Slides, Google Docs or a PDF',
					},
					{
						name: 'Project',
						value: 'project',
						description: 'A folder of documents in the workspace',
					},
					{
						name: 'Run',
						value: 'run',
						description: 'A run of a document: its status, its file and its deliveries',
					},
				],
				default: 'document',
			},
			...documentOperations,
			...documentFields,
			...projectOperations,
			...projectFields,
			...runOperations,
			...runFields,
		],
	};

	methods = nodeMethods;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		const errorOutput = this.getNode().onError === 'continueErrorOutput';

		// Generate sends one request for the whole execution, never one per item.
		if (resource === 'document' && operation === 'generate') {
			try {
				return [await executeDocumentGenerate(this)];
			} catch (error) {
				if (this.continueOnFail()) {
					const pairedItem = this.getInputData().map((_item, index) => ({ item: index }));
					return [
						buildGenerateErrorItems(asNodeError(this.getNode(), error), pairedItem, errorOutput),
					];
				}
				throw asNodeError(this.getNode(), error);
			}
		}

		// The four reads: one call per input item, each read by its own parameters.
		const executor = READ_EXECUTORS[`${resource}.${operation}`];
		if (executor === undefined) {
			throw new NodeOperationError(
				this.getNode(),
				`The operation '${operation}' on '${resource}' is not supported`,
				{
					description:
						"Pick one of the operations listed under 'Operation' for this 'Resource'. Nothing was sent.",
				},
			);
		}

		const returnData: INodeExecutionData[] = [];
		const items = this.getInputData();
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				returnData.push(...(await executor(this, itemIndex)));
			} catch (error) {
				if (this.continueOnFail()) {
					const nodeError = asNodeError(this.getNode(), error, itemIndex);
					returnData.push({
						json: errorJson(nodeError.message, errorFacts(nodeError), errorOutput),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(this.getNode(), error, itemIndex);
			}
		}

		return [returnData];
	}
}
