/**
 * Building `inline_data` from the Data Sets collection, and refusing a bad entry before
 * anything is sent — "a Rows value that is not an array of plain objects is a
 * `NodeOperationError` naming the entry, before anything is sent".
 */
import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { assertId } from './ids';

/**
 * Sets `key` as an own data property, so that a key such as `__proto__` is stored as a key and
 * never reaches the prototype setter. `object[key] = value` would drop it silently.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/** An `inline_data` object from `[dataSetId, rows]` pairs, each key an own property (see {@link setOwn}). */
export function inlineDataFrom(pairs: Iterable<readonly [string, IDataObject[]]>): IDataObject {
	const inlineData: IDataObject = {};
	for (const [dataSetId, rows] of pairs) {
		setOwn(inlineData, dataSetId, rows);
	}
	return inlineData;
}

export interface DataSetEntry {
	dataSetId: string;
	rows: unknown;
}

/** A short, human name for a JS value's shape, for an error message. */
function describeShape(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	return `a ${typeof value}`;
}

/** One entry's Rows, parsed into a plain array of plain row objects, or a `NodeOperationError`. */
function parseRows(
	node: INode,
	entry: DataSetEntry,
	position: number,
	collection: string,
): IDataObject[] {
	let value = entry.rows;

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') {
			value = [];
		} else {
			try {
				value = JSON.parse(trimmed);
			} catch {
				throw new NodeOperationError(
					node,
					`'Rows' of entry ${position + 1} in '${collection}' is not valid JSON`,
					{
						description:
							"'Rows' must evaluate to a JSON array of objects, one per row, each field named after a column — for example {{ $input.all().map(i => i.json) }}.",
					},
				);
			}
		}
	}

	if (!Array.isArray(value)) {
		throw new NodeOperationError(
			node,
			`'Rows' of entry ${position + 1} in '${collection}' must be a JSON array of objects, one per row`,
			{
				description: `Got ${describeShape(value)} instead. Set 'Rows' to an expression such as {{ $input.all().map(i => i.json) }}.`,
			},
		);
	}

	return value.map((row, rowIndex) => {
		if (typeof row !== 'object' || row === null || Array.isArray(row)) {
			throw new NodeOperationError(
				node,
				`Row ${rowIndex} of 'Rows' in entry ${position + 1} of '${collection}' is not a plain object`,
				{
					description:
						"Every row must be an object whose fields are the Data Set's column names. Fix that row in 'Rows', or filter it out before this node.",
				},
			);
		}
		return row as IDataObject;
	});
}

/** One Data Sets entry, parsed: a real Data Set id and its Rows as a plain array of objects. */
export interface ParsedDataSetEntry {
	dataSetId: string;
	rows: IDataObject[];
}

/**
 * The Data Sets collection, parsed and refused before anything is built: an entry with no Data
 * Set picked, a Data Set picked twice, or Rows that do not evaluate to an array of plain
 * objects, is a `NodeOperationError` naming the entry — none of that depends on what the rows'
 * keys are, which is `applyUnknownKeys`'s job once these are parsed.
 */
export function parseDataSetEntries(
	node: INode,
	entries: DataSetEntry[],
	collection = 'Data Sets',
): ParsedDataSetEntry[] {
	const seen = new Set<string>();

	return entries.map((entry, position) => {
		if (typeof entry.dataSetId !== 'string' || entry.dataSetId.trim() === '') {
			throw new NodeOperationError(
				node,
				`Entry ${position + 1} in '${collection}' has no 'Data Set' selected`,
				{
					description: `Pick a 'Data Set' for every entry in '${collection}', or remove the empty entry.`,
				},
			);
		}
		const dataSetId = assertId(node, 'Data Set', entry.dataSetId);
		if (seen.has(dataSetId)) {
			throw new NodeOperationError(
				node,
				`Entry ${position + 1} in '${collection}' picks the same 'Data Set' as an earlier entry`,
				{
					description: `Each Data Set may appear once in '${collection}'. Remove the repeated entry, or pick another 'Data Set'.`,
				},
			);
		}
		seen.add(dataSetId);
		return { dataSetId, rows: parseRows(node, entry, position, collection) };
	});
}

/** `inline_data`, plus which keys (if any) {@link dropUnknownKeys} removed from each Data Set's rows. */
export interface UnknownKeysResult {
	inlineData: IDataObject;
	droppedKeys: Record<string, string[]>;
}

/**
 * Drops, from every row, the keys that are not one of that entry's Data Set's own column names
 * (the **Unknown Fields: Drop** policy, the default). An n8n source's own metadata keys —
 * Airtable's `id`/`createdTime`, the Form Trigger's `submittedAt`/`formMode` — land on every
 * item it produces whether or not the destination Data Set has a column by that name, and the
 * API refuses the *whole* call over just one of them (`inline_column_unknown`). Dropping them
 * first, and reporting their names back as `dropped_keys`, makes the common case (send an
 * upstream node's items as is) work without a projection step while still surfacing a genuine
 * typo rather than silently discarding it.
 *
 * An entry whose Data Set id the Document does not recognise is left untouched: the API's own
 * `inline_data_set_unknown` refusal, naming it, is the right answer there — guessing which keys
 * are "wrong" for a Data Set we have no columns for would be worse than refusing.
 */
export function dropUnknownKeys(
	entries: ParsedDataSetEntry[],
	columnsByDataSetId: ReadonlyMap<string, ReadonlySet<string>>,
): UnknownKeysResult {
	const inlineData: IDataObject = {};
	const droppedKeys: Record<string, string[]> = {};

	for (const { dataSetId, rows } of entries) {
		const validColumns = columnsByDataSetId.get(dataSetId);
		// A Data Set with no listed column (its Table is missing from the stored schema) is treated like
		// an unknown one: stripping every key would hide the API's own answer.
		if (validColumns === undefined || validColumns.size === 0) {
			setOwn(inlineData, dataSetId, rows);
			continue;
		}

		const dropped = new Set<string>();
		setOwn(
			inlineData,
			dataSetId,
			rows.map((row) => {
				const cleaned: IDataObject = {};
				for (const [key, value] of Object.entries(row)) {
					if (validColumns.has(key)) {
						setOwn(cleaned, key, value);
					} else {
						dropped.add(key);
					}
				}
				return cleaned;
			}),
		);

		if (dropped.size > 0) {
			setOwn(droppedKeys, dataSetId, [...dropped]);
		}
	}

	return { inlineData, droppedKeys };
}
