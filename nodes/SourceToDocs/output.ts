/**
 * The Output option (node version 1.1 and later): Simplified, Raw or Selected Fields.
 *
 * Version 1 keeps its Simplify boolean exactly as it was (`applySimplify` in `runs.ts`); the
 * description shows one or the other by `@version`, and this file reads whichever the node has.
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
export function readOutputChoice(context: IExecuteFunctions, itemIndex: number): OutputChoice {
	const node = context.getNode();
	if (node.typeVersion < OUTPUT_OPTION_VERSION) {
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
	const unknown = fields.filter(
		(field) => !(SELECTABLE_FIELDS as readonly string[]).includes(field),
	);
	if (unknown.length > 0) {
		throw new NodeOperationError(
			node,
			`Unknown field in 'Fields': ${unknown.map((field) => `'${boundText(field, 40)}'`).join(', ')}`,
			{
				description: `Pick from these fields in 'Fields': ${SELECTABLE_FIELDS.join(', ')}. Nothing was sent.`,
			},
		);
	}
	return { extended: true, mode: 'selected', fields };
}

/** Fields Selected Fields never drops: the ids a later Run → Get needs. */
const ALWAYS_KEPT_FIELDS = ['run_id', 'batch_run_id'] as const;

/** Flattened items as the choice leaves them. Simplified drops `run`; Raw keeps everything; Selected keeps only the picked keys that are there. */
export function applyOutput(items: IDataObject[], choice: OutputChoice): IDataObject[] {
	if (choice.mode === 'selected' && choice.extended) {
		return items.map((item) => {
			const kept: IDataObject = {};
			for (const field of choice.fields) {
				if (field in item) kept[field] = item[field];
			}
			// The id always stays, so a timed-out item can still be polled with Run → Get.
			for (const field of ALWAYS_KEPT_FIELDS) {
				if (field in item && !(field in kept)) kept[field] = item[field];
			}
			return kept;
		});
	}
	return applySimplify(items, choice.mode === 'simplified');
}
