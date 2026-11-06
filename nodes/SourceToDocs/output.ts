/**
 * The Output option (node version 1.1 and later): Simplified, Raw or Selected Fields.
 *
 * Version 1 keeps its Simplify boolean exactly as it was (`applySimplify` in `runs.ts`); the
 * description shows one or the other by `@version`, and this file reads whichever the node has.
 *
 * What Output offers depends on what an operation returns: a flattened run (Generate, Run → Get)
 * or a Document (Document → Get). Each has its own {@link OutputProfile}.
 */
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { applySimplify } from './runs';
import { boundText } from './text';

export type OutputMode = 'simplified' | 'raw' | 'selected';

/** What the node's Output parameters (or v1's Simplify) ask for, resolved once before anything is sent. */
export type OutputChoice =
	| { extended: false; mode: 'simplified' | 'raw' }
	| { extended: true; mode: OutputMode; fields: string[] };

/** The first node version with the Output option. */
export const OUTPUT_OPTION_VERSION = 1.1;

/** Every field Selected Fields can keep: a flattened run item's own keys, plus `batch_run_id` on a batch's children and the full `run`. */
export const SELECTABLE_FIELDS = [
	'batch_run_id',
	'deliveries',
	'document_id',
	'error_code',
	'error_message',
	'file_count',
	'file_name',
	'file_url',
	'finished_at',
	'folder_url',
	'generation_stats',
	'kind',
	'page_count',
	'processing_started_at',
	'progress',
	'run',
	'run_id',
	'split_key',
	'status',
	'warnings',
] as const;

/** What an operation's Output offers: its fields, the ones Simplified keeps, and the ids that always stay. */
export interface OutputProfile {
	/** Every field Selected Fields can keep. */
	fields: readonly string[];
	/** What Selected Fields starts with. */
	defaultFields: string[];
	/** Fields Selected Fields never drops (when the item has them): the ids a later read needs. */
	alwaysKept: readonly string[];
	/** Whether node version 1 has the Simplify boolean (a run does; a Document → Get never had one). */
	hasLegacySimplify: boolean;
	/** One item as Simplified leaves it. */
	simplify: (item: IDataObject) => IDataObject;
	/** The noun for error texts. */
	noun: string;
}

/** The ten fields Simplified keeps on a flattened run, most used first. */
export const SIMPLIFIED_RUN_FIELDS = [
	'run_id',
	'status',
	'file_url',
	'file_name',
	'split_key',
	'file_count',
	'deliveries',
	'warnings',
	'error_code',
	'error_message',
] as const;

/** A batch's file keeps the id that leads back to its batch, whenever it carries one. */
const BATCH_ID_FIELD = 'batch_run_id';

function simplifiedRun(item: IDataObject): IDataObject {
	const kept: IDataObject = {};
	for (const field of SIMPLIFIED_RUN_FIELDS) {
		if (field in item) kept[field] = item[field];
	}
	if (BATCH_ID_FIELD in item) kept[BATCH_ID_FIELD] = item[BATCH_ID_FIELD];
	return kept;
}

/** Document → Get's top-level keys, which Selected Fields can keep. */
export const DOCUMENT_FIELDS = [
	'created_at',
	'data_sets',
	'distributions',
	'generate_pdf',
	'id',
	'name',
	'project_id',
	'project_name',
	'split',
	'split_enabled',
	'type',
	'updated_at',
] as const;

/** The fields Simplified keeps on a Document, in this order. */
export const SIMPLIFIED_DOCUMENT_FIELDS = [
	'id',
	'name',
	'type',
	'project_id',
	'project_name',
	'split_enabled',
	'generate_pdf',
	'data_sets',
	'distributions',
] as const;

function simplifiedDocument(item: IDataObject): IDataObject {
	const kept: IDataObject = {};
	for (const field of SIMPLIFIED_DOCUMENT_FIELDS) {
		if (!(field in item)) continue;
		const value = item[field];
		if (field === 'data_sets' && Array.isArray(value)) {
			kept[field] = (value as IDataObject[]).map((dataSet) => ({
				id: dataSet.id,
				name: dataSet.name,
				columns: Array.isArray(dataSet.columns)
					? (dataSet.columns as IDataObject[]).map((column) => column.name)
					: [],
			}));
		} else if (field === 'distributions' && Array.isArray(value)) {
			kept[field] = (value as IDataObject[]).map((distribution) => ({
				id: distribution.id,
				label: distribution.label,
				is_enabled: distribution.is_enabled,
			}));
		} else {
			kept[field] = value;
		}
	}
	return kept;
}

export const RUN_OUTPUT: OutputProfile = {
	fields: SELECTABLE_FIELDS,
	defaultFields: ['run_id', 'status', 'file_url'],
	alwaysKept: ['run_id', 'batch_run_id'],
	hasLegacySimplify: true,
	simplify: simplifiedRun,
	noun: 'run',
};

export const DOCUMENT_OUTPUT: OutputProfile = {
	fields: DOCUMENT_FIELDS,
	defaultFields: ['id', 'name', 'data_sets'],
	alwaysKept: ['id'],
	hasLegacySimplify: false,
	simplify: simplifiedDocument,
	noun: 'document',
};

function fieldsFrom(raw: unknown): string[] {
	if (Array.isArray(raw))
		return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
	if (typeof raw === 'string') {
		return raw
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
	}
	return [];
}

/**
 * Reads Output (1.1+) or Simplify (v1). Selected Fields refuses an empty or unknown selection, so a
 * Generate never starts a run it would then show as `{}`.
 */
export function readOutputChoice(
	context: IExecuteFunctions,
	itemIndex: number,
	profile: OutputProfile = RUN_OUTPUT,
): OutputChoice {
	const node = context.getNode();
	if (node.typeVersion < OUTPUT_OPTION_VERSION) {
		if (!profile.hasLegacySimplify) return { extended: false, mode: 'raw' };
		const simplify = context.getNodeParameter('simplify', itemIndex, true) as boolean;
		return { extended: false, mode: simplify ? 'simplified' : 'raw' };
	}

	const mode = context.getNodeParameter('output', itemIndex, 'simplified') as string;
	if (mode === 'raw' || mode === 'simplified') {
		return { extended: true, mode, fields: [] };
	}
	if (mode !== 'selected') {
		throw new NodeOperationError(
			node,
			`'Output' has an unsupported value: ${JSON.stringify(boundText(mode, 40))}`,
			{
				description: "Set 'Output' to Simplified, Raw or Selected Fields. Nothing was sent.",
			},
		);
	}

	const fields = fieldsFrom(
		context.getNodeParameter('outputFields', itemIndex, [], { skipValidation: true }),
	);
	if (fields.length === 0) {
		throw new NodeOperationError(node, "'Output' is Selected Fields, but 'Fields' is empty", {
			description:
				"Pick the fields to keep in 'Fields', or set 'Output' to Simplified or Raw. Nothing was sent.",
		});
	}
	const unknown = fields.filter((field) => !profile.fields.includes(field));
	if (unknown.length > 0) {
		throw new NodeOperationError(
			node,
			`Unknown field in 'Fields': ${unknown.map((field) => `'${boundText(field, 40)}'`).join(', ')}`,
			{
				description: `Pick from these fields in 'Fields': ${profile.fields.join(', ')}. Nothing was sent.`,
			},
		);
	}
	return { extended: true, mode: 'selected', fields };
}

/**
 * Items as the choice leaves them. Simplified keeps the profile's own short list (at node version 1,
 * a run only loses its `run` key); Raw keeps everything; Selected keeps only the picked keys that are there.
 */
export function applyOutput(
	items: IDataObject[],
	choice: OutputChoice,
	profile: OutputProfile = RUN_OUTPUT,
): IDataObject[] {
	if (choice.mode === 'selected' && choice.extended) {
		return items.map((item) => {
			const kept: IDataObject = {};
			for (const field of choice.fields) {
				if (field in item) kept[field] = item[field];
			}
			// The id always stays, so a timed-out item can still be polled with Run → Get.
			for (const field of profile.alwaysKept) {
				if (field in item && !(field in kept)) kept[field] = item[field];
			}
			return kept;
		});
	}
	if (choice.extended) {
		return choice.mode === 'simplified' ? items.map((item) => profile.simplify(item)) : items;
	}
	return profile.hasLegacySimplify ? applySimplify(items, choice.mode === 'simplified') : items;
}
