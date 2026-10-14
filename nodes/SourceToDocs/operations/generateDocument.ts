/** Document → Generate: one `POST`, then an optional wait, then one item per produced file. */
import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	IPairedItemData,
	NodeExecutionHint,
	ResourceMapperField,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { assertId, assertIds, idForPath } from '../ids';
import { applyOutput, readOutputChoice } from '../output';
import {
	dropUnknownKeys,
	inlineDataFrom,
	parseDataSetEntries,
	type DataSetEntry,
	type ParsedDataSetEntry,
} from '../inlineData';
import {
	fetchRun,
	fetchRunChildren,
	flattenBatchResult,
	flattenRun,
	getRetrying,
	resolveWaitOptions,
	waitForTerminalRun,
	withRunId,
} from '../runs';
import {
	automaticIdempotencyKey,
	existingRunIdOf,
	isOlderThanAdoptionWindow,
	keyAfterFailedRun,
	startRun,
} from '../startRun';
import { missingSplitKeys } from '../splitKey';
import { RUN_ERROR_CODES_URL, boundText, codeLink } from '../text';
import type { PublicDocumentData, RunData } from '../types';

/** Failed runs one start steps over at most: a retry budget is 5 tries, so a chain this long is a misbehaving server. */
const MAX_KEY_CHAIN = 10;

/** The Data Sets collection's raw shape: `{ values: [{ dataSetId, rows }, ...] }`, or empty. */
interface DataSetsParameter {
	values?: DataSetEntry[];
}

/**
 * `inline_data` from parsed entries, with Unknown Fields applied. **Refuse** — or a caller with
 * nothing to clean (`mayHaveUnknownKeys` false) — sends rows as given and never reads the
 * document; **Drop** reads it once to learn each Data Set's real columns.
 */
async function applyUnknownKeys(
	readDocument: () => Promise<PublicDocumentData>,
	entries: ParsedDataSetEntry[],
	unknownKeys: 'drop' | 'refuse',
	mayHaveUnknownKeys: boolean,
): Promise<{ inlineData: IDataObject; droppedKeys: Record<string, string[]> | undefined }> {
	if (unknownKeys === 'refuse' || !mayHaveUnknownKeys) {
		const inlineData = inlineDataFrom(
			entries.map((entry) => [entry.dataSetId, entry.rows] as const),
		);
		return { inlineData, droppedKeys: undefined };
	}

	const document = await readDocument();
	const columnsByDataSetId = new Map(
		document.data_sets.map((dataSet) => [
			dataSet.id,
			new Set(dataSet.columns.map((column) => column.name)),
		]),
	);
	return dropUnknownKeys(entries, columnsByDataSetId);
}

/**
 * Map Columns' own Data Set, one row per input item: Map Each Column Manually reads each item's
 * mapped values (by item index, so an expression resolves against its own item); Map
 * Automatically takes each item's own fields, for Unknown Fields to clean afterwards.
 */
function buildMappedEntry(context: IExecuteFunctions): {
	entry: ParsedDataSetEntry;
	autoMap: boolean;
	/** Shown columns whose value is `undefined` or `null` in every item (Map Each Column Manually). */
	emptyColumns: string[];
} {
	const node = context.getNode();
	const rawDataSetId = context.getNodeParameter('mappedDataSetId', 0, '') as unknown;
	if (typeof rawDataSetId === 'string' && rawDataSetId.trim() === '') {
		throw new NodeOperationError(node, "'Map Columns' has no 'Data Set' selected", {
			description: "Pick the 'Data Set' whose columns you want to map.",
		});
	}

	const dataSetId = assertId(node, 'Data Set', rawDataSetId);

	const items = context.getInputData();
	const mappingMode = context.getNodeParameter('columns.mappingMode', 0, 'defineBelow') as string;
	const autoMap = mappingMode === 'autoMapInputData';

	// The editor seeds the mapping with `null` for every column still hidden in the "add column"
	// list; those were never added, so they are not sent. A column the person did add and left
	// empty is `visible` and goes as it comes.
	const hidden = new Set<string>();
	const shownInSchema: string[] = [];
	if (!autoMap) {
		const schema = (context.getNodeParameter('columns.schema', 0, []) ??
			[]) as ResourceMapperField[];
		for (const field of schema) {
			if (field.removed === true) {
				hidden.add(field.id);
			} else {
				shownInSchema.push(field.id);
			}
		}
	}

	// Every shown column's resolved value per item, `undefined` included: a column that is empty in
	// every item is reported while the row itself leaves an `undefined` out.
	const resolved = items.map((_item, index): IDataObject => {
		if (autoMap) {
			return { ...items[index].json };
		}
		// `skipValidation`: n8n would otherwise convert or refuse a value by its column's type
		// (`""` to 0, a date to an ISO timestamp, "yes" into a boolean). Values go as the mapping
		// resolved them and the API judges them, as in JSON mode.
		const mapped = (context.getNodeParameter(
			'columns.value',
			index,
			{},
			{
				skipValidation: true,
			},
		) ?? {}) as IDataObject;
		return Object.fromEntries(Object.entries(mapped).filter(([column]) => !hidden.has(column)));
	});

	const rows = resolved.map((row) =>
		autoMap
			? row
			: Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
	);

	const emptyColumns: string[] = [];
	if (!autoMap) {
		// A shown column the editor stored no value for (an untouched one) is `undefined` in every item.
		const shown = new Set([...shownInSchema, ...resolved.flatMap((row) => Object.keys(row))]);
		for (const column of shown) {
			if (resolved.every((row) => row[column] === undefined || row[column] === null)) {
				emptyColumns.push(column);
			}
		}
	}

	if (!autoMap && rows.length > 0 && rows.every((row) => Object.keys(row).length === 0)) {
		throw emptyMappingError(node, emptyColumns);
	}

	return { entry: { dataSetId, rows }, autoMap, emptyColumns };
}

/**
 * The guard's refusal: no row carries any value, so the document would be blank. The likely cause
 * is an expression that resolved to nothing (a list field read like an object), so the fix for
 * that comes first and the mapping reset second.
 */
function emptyMappingError(node: INode, columns: string[]): NodeOperationError {
	const reset =
		"Picking another 'Document' or 'Data Set' resets the mapping: map the columns again, or use Map Automatically.";
	if (columns.length === 0) {
		return new NodeOperationError(node, "'Map Columns' has no column mapped", {
			description: `No input item carries a mapped value, so the document would be blank. Map at least one column. ${reset} Nothing was sent.`,
		});
	}
	const list = columns.map((column) => `'${boundText(column, 60)}'`).join(', ');
	return new NodeOperationError(
		node,
		`'Map Columns' has nothing to send: ${list} resolved to nothing in every input item`,
		{
			description: `Every mapped expression gave no value, so every row would be blank. An expression such as {{ $json.clients.name }} does this when the field is a list: put a Split Out node before this one, or use .map(...) on the list field. Otherwise the mapping may have been reset. ${reset} Nothing was sent.`,
		},
	);
}

/**
 * Whether the mapped Data Set's rows leave a column of the document's split key empty. It reads
 * the document, which Map Columns otherwise never does. A key the API does not publish is not checked.
 */
async function checkSplitKey(
	readDocument: () => Promise<PublicDocumentData>,
	entry: ParsedDataSetEntry,
): Promise<string[]> {
	return missingSplitKeys(await readDocument(), entry.dataSetId, entry.rows);
}

/** How many rows, over every Data Set in `inline_data` as it is sent, are `{}`. */
function countEmptyRows(inlineData: IDataObject): number {
	return Object.values(inlineData).reduce<number>(
		(count, rows) =>
			count + (rows as IDataObject[]).filter((row) => Object.keys(row).length === 0).length,
		0,
	);
}

/**
 * The Idempotency Key as the node holds it. An expression's value reaches the node untyped, so
 * a number stays a number (used as its text), and nothing at all (a missing field, a `$fromAI` the
 * model left out) is refused with a message naming the parameter. An empty or blank string means no
 * key of the person's own: the automatic key applies.
 */
function idempotencyKeyFrom(node: INode, raw: unknown): string {
	if (typeof raw === 'string') {
		return raw.trim();
	}
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return String(raw);
	}
	const shown =
		raw === undefined || raw === null
			? 'nothing'
			: Array.isArray(raw)
				? 'a list'
				: typeof raw === 'number'
					? 'a number that is not finite'
					: `a ${typeof raw}`;
	throw new NodeOperationError(node, `'Idempotency Key' resolved to ${shown}`, {
		description:
			"'Idempotency Key' must be text or a number, for example {{ $json.order_id }}. Leave it empty for the key the node makes itself. Nothing was sent.",
	});
}

interface RequestBodyResult {
	body: IDataObject;
	/** Set only when rows came from this workflow — `undefined` means "not applicable", not "nothing dropped". */
	droppedKeys: Record<string, string[]> | undefined;
	/** Map Columns: shown columns empty in every item. Empty when none, or not Map Columns. */
	emptyColumns: string[];
	/** Rows that are `{}` in the rows sent from this workflow. */
	emptyRows: number;
	/** Map Columns, split document: key columns no row fills. Empty when none, or not checked. */
	missingSplitKeys: string[];
	rowsFrom: 'connected' | 'workflow' | 'mapped';
	/** The key was made by the node, not set by the person: it adopts only a recent run. */
	automaticKey: boolean;
}

/**
 * Builds the `POST /documents/{document}/runs` body from the node's own parameters.
 *
 * For rows from this workflow, Unknown Fields decides what happens to a row field that is not one
 * of its Data Set's own columns: **Refuse** sends rows exactly as given, so a bad field is
 * the API's own `inline_column_unknown`; **Drop** (the default) reads the document once more —
 * the same `GET /documents/{document}` the Data Set picker already calls — to learn each Data
 * Set's real columns, strips anything else from every row first, and returns the removed names
 * so the caller can report them.
 */
async function buildRequestBody(
	context: IExecuteFunctions,
	documentPath: string,
	budgetMs: number,
): Promise<RequestBodyResult> {
	const node = context.getNode();
	const rowsFrom = context.getNodeParameter('rowsFrom', 0) as 'connected' | 'workflow' | 'mapped';
	const distributionIds = assertIds(
		node,
		'Deliver To',
		context.getNodeParameter('distributionIds', 0, []),
	);
	const idempotencyKey = idempotencyKeyFrom(
		node,
		context.getNodeParameter('idempotencyKey', 0, '', { skipValidation: true }),
	);

	// One read of the document serves both Unknown Fields and the split key check.
	let documentRead: Promise<PublicDocumentData> | undefined;
	const readDocument = (): Promise<PublicDocumentData> => {
		documentRead ??= getRetrying<{ document: PublicDocumentData }>(
			context,
			`/documents/${documentPath}`,
			budgetMs,
		).then((response) => response.document);
		return documentRead;
	};

	const body: IDataObject = {};
	let droppedKeys: Record<string, string[]> | undefined;
	let emptyColumns: string[] = [];
	let emptyRows = 0;
	let missingKeys: string[] = [];

	if (rowsFrom === 'workflow') {
		const dataSets = context.getNodeParameter('dataSets', 0, {}) as DataSetsParameter;
		const parsedEntries = parseDataSetEntries(node, dataSets.values ?? []);
		const unknownKeys = context.getNodeParameter('unknownKeys', 0, 'drop') as 'drop' | 'refuse';

		({ inlineData: body.inline_data, droppedKeys } = await applyUnknownKeys(
			readDocument,
			parsedEntries,
			unknownKeys,
			true,
		));
		// Counted on what is sent: a row Drop emptied is blank in the document too.
		emptyRows = countEmptyRows(body.inline_data as IDataObject);
	} else if (rowsFrom === 'mapped') {
		const mapped = buildMappedEntry(context);
		const additional = context.getNodeParameter('additionalDataSets', 0, {}) as DataSetsParameter;
		const additionalEntries = parseDataSetEntries(
			node,
			additional.values ?? [],
			'Additional Data Sets',
		);
		if (additionalEntries.some((entry) => entry.dataSetId === mapped.entry.dataSetId)) {
			throw new NodeOperationError(
				node,
				`Data Set ${mapped.entry.dataSetId} is mapped in 'Map Columns' and also listed in 'Additional Data Sets'`,
				{
					description:
						"The mapped Data Set gets its rows from the incoming items. Remove it from 'Additional Data Sets', or pick another 'Data Set' to map.",
				},
			);
		}
		const unknownKeys = context.getNodeParameter('unknownKeys', 0, 'drop') as 'drop' | 'refuse';
		emptyColumns = mapped.emptyColumns;
		missingKeys = await checkSplitKey(readDocument, mapped.entry);

		// Rows of exactly the mapped columns have no unknown key to drop: Unknown Fields cleans
		// only Map Automatically rows (an item's own fields) and Additional Data Sets' JSON rows.
		// Manual rows go as mapped, the mapped Data Set first.
		const toClean = mapped.autoMap ? [mapped.entry, ...additionalEntries] : additionalEntries;
		const cleaned = await applyUnknownKeys(readDocument, toClean, unknownKeys, toClean.length > 0);
		if (mapped.autoMap) {
			body.inline_data = cleaned.inlineData;
		} else {
			body.inline_data = inlineDataFrom([
				[mapped.entry.dataSetId, mapped.entry.rows],
				...(Object.entries(cleaned.inlineData) as Array<[string, IDataObject[]]>),
			]);
		}
		droppedKeys = cleaned.droppedKeys;
		emptyRows = countEmptyRows(body.inline_data as IDataObject);
	}

	if (distributionIds.length > 0) {
		body.distribution_ids = distributionIds;
	}

	// A key the person set goes unchanged. Otherwise the node sends its own, the same on every Retry
	// On Fail try of this node run: a retry then meets the conflict and adopts the first run.
	const key =
		idempotencyKey !== ''
			? idempotencyKey
			: automaticIdempotencyKey(context, { documentPath, body });
	if (key !== undefined) {
		body.idempotency_key = key;
	}

	return {
		body,
		droppedKeys,
		emptyColumns,
		emptyRows,
		missingSplitKeys: missingKeys,
		rowsFrom,
		automaticKey: idempotencyKey === '',
	};
}

/**
 * What the rows said about themselves: empty columns and empty rows go on the output item and
 * into an n8n execution hint; Execute Once in Map Columns gets its own hint. The rows are
 * sent as they are either way.
 */
function addRowHints(
	context: IExecuteFunctions,
	extras: IDataObject,
	facts: {
		emptyColumns: string[];
		emptyRows: number;
		missingSplitKeys: string[];
		rowsFrom: string;
	},
): void {
	const hints: NodeExecutionHint[] = [];
	if (facts.emptyColumns.length > 0) {
		extras.empty_columns = facts.emptyColumns;
		const list = facts.emptyColumns.map((column) => `'${boundText(column, 60)}'`).join(', ');
		hints.push({
			type: 'warning',
			location: 'outputPane',
			message: `'Map Columns': ${list} had no value (undefined or null) in any input item, and was sent empty. If an expression reads a list field, such as {{ $json.clients.name }}, put a Split Out node before this one, or use .map(...) on the list.`,
		});
	}
	if (facts.emptyRows > 0) {
		extras.empty_rows = facts.emptyRows;
		hints.push({
			type: 'warning',
			location: 'outputPane',
			message: `${facts.emptyRows} row(s) had no fields at all (for example an item with only binary data) and were sent as blank rows. Filter them out before this node if they should not be in the document.`,
		});
	}
	if (facts.missingSplitKeys.length > 0) {
		extras.missing_split_keys = facts.missingSplitKeys;
		const list = facts.missingSplitKeys.map((column) => `'${boundText(column, 60)}'`).join(', ');
		hints.push({
			type: 'warning',
			location: 'outputPane',
			message: `This document is split by ${list}, and no input item gives it a value. A row without a key produces no file, so the batch will have no files. Map ${facts.missingSplitKeys.length === 1 ? 'that column' : 'those columns'} in 'Map Columns' (add it from the add-column list if it is hidden).`,
		});
	}
	if (facts.rowsFrom === 'mapped' && context.getNode().executeOnce === true) {
		hints.push({
			type: 'warning',
			location: 'outputPane',
			message:
				"'Execute Once' is on, so 'Map Columns' sends only the first input item as a row. Turn 'Execute Once' off to send one row per item, or set 'Rows Come From' to JSON to send every item with 'Execute Once' on.",
		});
	}
	if (hints.length > 0) {
		context.addExecutionHints(...hints);
	}
}

/** Every item, paired to every input item and with `extras`' fields merged in. */
function toExecutionData(
	items: IDataObject[],
	pairedItem: IPairedItemData[],
	extras: IDataObject = {},
): INodeExecutionData[] {
	return items.map((json) => ({ json: { ...json, ...extras }, pairedItem }));
}

/** Server text bounded for a message, or `fallback` when there is none. */
function boundedOr(text: string | null | undefined, fallback: string): string {
	return typeof text === 'string' ? boundText(text) : fallback;
}

/** A `failed` *single* Run, as a `NodeOperationError` naming its own code (no batch to list). */
function runFailedError(node: INode, run: RunData): NodeOperationError {
	const error = new NodeOperationError(
		node,
		boundedOr(run.error_message, 'The run ended before the document was produced'),
		{
			description:
				run.error_code !== null
					? `Code: ${boundText(run.error_code)}. See ${codeLink(run.error_code)} for what this code means and how to fix it, then run the document again`
					: `The run ended without a code. See ${RUN_ERROR_CODES_URL} for the codes a run can end with, then run the document again`,
		},
	);
	error.context.errorCode = run.error_code;
	return error;
}

/**
 * A `failed` *batch* Run, explained: lists `/children`, names the batch id and the first
 * three failed children's own `error_code` (then a count of the rest), and carries the full
 * failed-children list on `context.failedChildren` so `continueOnFail` can emit one item per
 * failed child instead of one opaque "The run failed".
 */
async function batchFailureError(
	context: IExecuteFunctions,
	node: INode,
	batch: RunData,
	budgetMs: number,
): Promise<NodeOperationError> {
	const children = await fetchRunChildren(context, batch.id, budgetMs);
	const failedChildren = children.filter((child) => child.status === 'failed');

	const firstThree = failedChildren
		.slice(0, 3)
		.map(
			(child) =>
				`${child.id} (${child.error_code === null ? 'no code' : boundText(child.error_code)})`,
		)
		.join(', ');
	const remaining = failedChildren.length - 3;
	const tail = remaining > 0 ? `, and ${remaining} more` : '';
	const childSummary = failedChildren.length > 0 ? ` Not produced: ${firstThree}${tail}.` : '';
	// One link per distinct code of the children named above, else the batch's own code, else the reference page.
	const codes = [
		...new Set(
			failedChildren
				.slice(0, 3)
				.map((child) => child.error_code)
				.filter((code): code is string => typeof code === 'string'),
		),
	];
	if (codes.length === 0 && typeof batch.error_code === 'string') {
		codes.push(batch.error_code);
	}
	const links =
		codes.length === 0
			? `See ${RUN_ERROR_CODES_URL} for what each code means and how to fix it`
			: `See ${codes.map((code) => `${boundText(code)}: ${codeLink(code)}`).join('; ')} for what each code means and how to fix it`;

	const error = new NodeOperationError(
		node,
		boundedOr(batch.error_message, 'The batch run ended before all of its documents were produced'),
		{
			description: `Batch run ID: ${batch.id}.${childSummary} ${links}, then run the document again.`,
		},
	);
	error.context.errorCode = batch.error_code;
	error.context.failedChildren = failedChildren.map((child) => ({
		run_id: child.id,
		error_code: child.error_code,
		error_message: child.error_message,
		split_key: child.split_key,
	}));
	return error;
}

/** Document → Generate: the start request, the optional wait, and the items to return. */
export async function executeDocumentGenerate(
	context: IExecuteFunctions,
): Promise<INodeExecutionData[]> {
	const node = context.getNode();
	const documentPath = idForPath(
		node,
		'Document',
		context.getNodeParameter('documentId', 0, undefined, { extractValue: true }),
	);
	const waitForCompletion = context.getNodeParameter('waitForCompletion', 0) as boolean;
	// Output (1.1+) or Simplify (v1), read before anything is sent: Selected Fields with nothing selected must not cost a run.
	const output = readOutputChoice(context, 0);
	const shape = (items: IDataObject[]): IDataObject[] => applyOutput(items, output);

	// Max Wait and Poll Every are read, converted and refused before anything is sent: a bad
	// value must not cost a run. They are hidden (and so default) when the node does not wait; Max
	// Wait then still bounds the start POST's retries.
	const waitOptions = waitForCompletion
		? resolveWaitOptions(
				node,
				context.getNodeParameter('maxWait', 0, undefined, { skipValidation: true }),
				context.getNodeParameter('pollEvery', 0, undefined, { skipValidation: true }),
			)
		: resolveWaitOptions(node, undefined, undefined);

	// One POST per execution regardless of how many items are on the input; every
	// output item pairs to every one of them, so `$('Node').item` fails loudly on this node
	// rather than silently answering with input 0.
	const pairedItem: IPairedItemData[] = context
		.getInputData()
		.map((_item, index) => ({ item: index }));

	const {
		body,
		droppedKeys,
		emptyColumns,
		emptyRows,
		missingSplitKeys: missingKeys,
		rowsFrom,
		automaticKey,
	} = await buildRequestBody(context, documentPath, waitOptions.maxWaitMs);
	const extras: IDataObject = droppedKeys !== undefined ? { dropped_keys: droppedKeys } : {};
	addRowHints(context, extras, {
		emptyColumns,
		emptyRows,
		missingSplitKeys: missingKeys,
		rowsFrom,
	});

	// A conflict that names the Run already holding the key is a retry of this very start. Its status decides:
	// a failed Run produced no document, so the retry starts one new Run under a key derived from it (and, if
	// that one failed too on an earlier try, the same rule applies again); any other status is adopted, unless the
	// key is the node's own and the Run is older than the adoption window: that is a repeated key, not a retry.
	let createdRun: RunData | undefined;
	for (let chained = 0; createdRun === undefined; chained++) {
		try {
			createdRun = await startRun(context, documentPath, body, waitOptions.maxWaitMs);
		} catch (error) {
			const existingRunId = existingRunIdOf(error);
			if (existingRunId === undefined) {
				throw error instanceof NodeApiError ? error : new NodeOperationError(node, error as Error);
			}
			let existing: RunData;
			try {
				existing = await fetchRun(context, existingRunId);
			} catch (readError) {
				throw withRunId(readError as Error, existingRunId);
			}
			if (
				(existing.status === 'failed' ||
					(automaticKey && isOlderThanAdoptionWindow(existing.created_at))) &&
				typeof body.idempotency_key === 'string' &&
				chained < MAX_KEY_CHAIN
			) {
				body.idempotency_key = keyAfterFailedRun(body.idempotency_key, existing.id);
				continue;
			}
			createdRun = existing;
			extras.idempotent_replay = true;
		}
	}

	if (!waitForCompletion) {
		return toExecutionData(shape([flattenRun(createdRun, output.extended)]), pairedItem, extras);
	}

	try {
		const { run: finalRun, timedOut } = await waitForTerminalRun(
			context,
			createdRun.id,
			createdRun,
			waitOptions,
		);

		if (timedOut) {
			return toExecutionData(
				shape([flattenRun(finalRun, output.extended)]).map((item) => ({
					...item,
					timed_out: true,
				})),
				pairedItem,
				extras,
			);
		}

		if (finalRun.status === 'failed') {
			throw finalRun.kind === 'batch'
				? await batchFailureError(context, node, finalRun, waitOptions.maxWaitMs)
				: runFailedError(node, finalRun);
		}

		if (finalRun.kind === 'batch') {
			const children = await fetchRunChildren(context, finalRun.id, waitOptions.maxWaitMs);
			return toExecutionData(
				shape(flattenBatchResult(finalRun, children, output.extended)),
				pairedItem,
				extras,
			);
		}

		return toExecutionData(shape([flattenRun(finalRun, output.extended)]), pairedItem, extras);
	} catch (error) {
		// Any error raised after the 201 names the Run it belongs to, so Retry On Fail
		// never reads as "no run was ever started" and starts a silent duplicate.
		throw withRunId(error as Error, createdRun.id);
	}
}
