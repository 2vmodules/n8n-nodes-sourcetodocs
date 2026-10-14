/**
 * The split key check. A split document makes one file per distinct key, and a row whose key
 * column is empty produces none: a Map Columns run that never fills the key column ends as a batch
 * with 0 files and no error. The run is still sent (warn, don't block); this only names the columns.
 */
import type { IDataObject } from 'n8n-workflow';

import type { PublicDocumentData } from './types';

/** A value that cannot make a key: nothing, `null`, or text that is only blank. */
function isBlank(value: unknown): boolean {
	return (
		value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
	);
}

/**
 * The key columns of `dataSetId` that no row fills, in the key's order. Empty (nothing to report) when
 * the document is not split, the split is off, the backend published no key (`null` or an older API),
 * the key belongs to another Data Set, or there are no rows.
 */
export function missingSplitKeys(
	document: PublicDocumentData,
	dataSetId: string,
	rows: IDataObject[],
): string[] {
	const key = document.split?.key;
	if (document.split?.enabled !== true || key === undefined || key === null) {
		return [];
	}
	if (key.data_set_id !== dataSetId || !Array.isArray(key.columns) || rows.length === 0) {
		return [];
	}
	return key.columns.filter((column) => rows.every((row) => isBlank(row[column])));
}
