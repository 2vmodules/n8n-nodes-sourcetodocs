/**
 * The four reads: Project → Get Many, Document → Get Many, Document → Get, Run → Get.
 *
 * Project → Get Many, Document → Get Many and Document → Get return the Public API's own
 * payload as items — a list as one item per element, an object as one item. Run → Get instead
 * flattens every item exactly as Document → Generate does: an ordinary run or a Summary
 * Only batch is one flattened item, and an ordinary batch lists its children the same way a
 * finished batch does for Generate — the same `file_url`-at-the-top-level promise holds either
 * way. Simplify (Output from node version 1.1) then decides what stays on each item.
 */
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { NodeOperationError } from 'n8n-workflow';

import { assertId, idForPath } from '../ids';
import { applyOutput, readOutputChoice } from '../output';
import {
	fetchRun,
	fetchRunChildren,
	flattenBatchResult,
	DEFAULT_MAX_WAIT_SECONDS,
	flattenRun,
	resolveWaitOptions,
} from '../runs';
import { sourceToDocsApiRequest } from '../transport';
import type { PublicDocumentData, PublicDocumentSummaryData, PublicProjectData } from '../types';

/**
 * Return All and Limit (node version 1.1 and later). The API has no paging, so Limit cuts the
 * list the node already has. Version 1 has neither parameter (the description shows them from 1.1,
 * and n8n leaves a hidden parameter out), so it reads the default, Return All, and returns everything.
 */
function limited<T>(context: IExecuteFunctions, itemIndex: number, list: T[]): T[] {
	if (context.getNodeParameter('returnAll', itemIndex, true) as boolean) return list;
	const raw: unknown = context.getNodeParameter('limit', itemIndex, 50, { skipValidation: true });
	const limit = typeof raw === 'string' && raw.trim() === '' ? 50 : Number(raw);
	if (!Number.isInteger(limit) || limit < 1) {
		throw new NodeOperationError(
			context.getNode(),
			`'Limit' must be a whole number of 1 or more, not ${JSON.stringify(raw)}`,
			{
				itemIndex,
				description: "Enter a whole number such as 50, or turn on 'Return All'. Nothing was sent.",
			},
		);
	}
	return list.slice(0, limit);
}

/** Every element of `list`, as its own item — the payload the API sent, unmodified. */
function toItems<T extends object>(list: T[], itemIndex: number): INodeExecutionData[] {
	return list.map((entry) => ({
		json: entry as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	}));
}

export async function executeProjectGetMany(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const { projects } = (await sourceToDocsApiRequest.call(context, 'GET', '/projects')) as {
		projects: PublicProjectData[];
	};
	return toItems(limited(context, itemIndex, projects), itemIndex);
}

export async function executeDocumentGetMany(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const projectId = idForPath(
		context.getNode(),
		'Project',
		context.getNodeParameter('projectId', itemIndex),
	);
	const { documents } = (await sourceToDocsApiRequest.call(
		context,
		'GET',
		`/projects/${projectId}/documents`,
	)) as { documents: PublicDocumentSummaryData[] };
	return toItems(limited(context, itemIndex, documents), itemIndex);
}

export async function executeDocumentGet(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const documentId = idForPath(
		context.getNode(),
		'Document',
		context.getNodeParameter('documentId', itemIndex, undefined, { extractValue: true }),
	);
	const { document } = (await sourceToDocsApiRequest.call(
		context,
		'GET',
		`/documents/${documentId}`,
	)) as {
		document: PublicDocumentData;
	};
	return toItems([document], itemIndex);
}

export async function executeRunGet(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const runId = assertId(context.getNode(), 'Run ID', context.getNodeParameter('runId', itemIndex));
	const summaryOnly = context.getNodeParameter('summaryOnly', itemIndex, false) as boolean;
	const output = readOutputChoice(context, itemIndex);

	// The same bounds as Generate's wait (at least one poll interval, at most 3600 s), read and refused before anything is sent.
	const { maxWaitMs } = resolveWaitOptions(
		context.getNode(),
		// Hidden for Summary Only and for version 1, where the fallback is the same 300 s Generate starts from.
		context.getNodeParameter('maxWait', itemIndex, DEFAULT_MAX_WAIT_SECONDS, {
			skipValidation: true,
		}),
		undefined,
	);

	const run = await fetchRun(context, runId);

	if (run.kind === 'single' || summaryOnly) {
		return toItems(applyOutput([flattenRun(run, output.extended)], output), itemIndex);
	}

	// An empty batch still answers with its own one flattened item, via flattenBatchResult.
	const children = await fetchRunChildren(context, run.id, maxWaitMs);
	return applyOutput(flattenBatchResult(run, children, output.extended), output).map((json) => ({
		json,
		pairedItem: { item: itemIndex },
	}));
}
