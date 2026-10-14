/**
 * The Public API's own shapes, as `public-api.json` (the exported Scramble contract) documents
 * them. Only the fields the node reads are declared; the API may send more.
 */
import type { IDataObject } from 'n8n-workflow';

export interface PublicProjectData {
	id: string;
	name: string;
	timezone: string | null;
}

export type PublicDocumentType = 'google_slides' | 'google_docs';

export interface PublicDocumentSummaryData {
	id: string;
	project_id: string;
	name: string;
	type: PublicDocumentType;
	split_enabled: boolean;
	generate_pdf: boolean;
	created_at: string;
	updated_at: string;
}

export type PublicColumnType = 'bool' | 'date' | 'file' | 'number' | 'relation' | 'select' | 'text';

export interface PublicColumnData {
	name: string;
	type: PublicColumnType;
	selected: boolean;
	/** A `select` column's choices by name, in source order; `null` (or absent, on an older API) means free text. */
	choices?: string[] | null;
}

export interface PublicDataSetData {
	id: string;
	name: string;
	alias: string;
	data_source_id: string;
	source_table_id: string | null;
	columns: PublicColumnData[];
}

export type PublicDistributionType = 'google_drive' | 'download';

export interface PublicDistributionData {
	id: string;
	type: PublicDistributionType;
	is_enabled: boolean;
	label: string;
}

export interface PublicSplitData {
	enabled: boolean;
	driver_data_source_id: string | null;
	driver_source_table_id: string | null;
	/**
	 * The key columns of the Data Set the split reads, by exact column name. `null` (or absent, on an
	 * older API) means the backend cannot tell, so the node does not check.
	 */
	key?: PublicSplitKeyData | null;
}

export interface PublicSplitKeyData {
	data_set_id: string;
	columns: string[];
}

export interface PublicDocumentData extends PublicDocumentSummaryData {
	split: PublicSplitData | null;
	data_sets: PublicDataSetData[];
	distributions: PublicDistributionData[];
}

export interface RunDistributionData {
	id: string;
	run_id: string;
	distribution_id: string | null;
	distribution_type: PublicDistributionType;
	status: 'pending' | 'succeeded' | 'failed';
	result: IDataObject | null;
	error_code: string | null;
	error_message: string | null;
	attempted_at: string | null;
	finished_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface RunProgress {
	total: number;
	succeeded: number;
	failed: number;
	partial_success: number;
	cancelled: number;
	processing: number;
	pending: number;
}

export interface GoogleSlidesRunResult {
	presentation_id: string;
	presentation_url: string;
	presentation_name: string;
	slide_count: number;
	source_presentation_id: string;
	source_name: string;
}

export interface GoogleDocsRunResult {
	document_id: string;
	document_url: string;
	document_name: string;
	page_count: number;
	source_document_id: string;
	source_name: string;
}

export type RenderedArtifact = GoogleSlidesRunResult | GoogleDocsRunResult;

/** The shape `output_result` takes for a Google Docs run: the only one with no `slide_count`. */
export function isGoogleDocsRunResult(result: RenderedArtifact): result is GoogleDocsRunResult {
	return 'document_url' in result;
}

export type RunStatus =
	| 'pending'
	| 'processing'
	| 'succeeded'
	| 'failed'
	| 'partial_success'
	| 'cancelling'
	| 'cancelled';

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
	'succeeded',
	'failed',
	'partial_success',
	'cancelled',
]);

/** One entry of a run's `warnings`: why it ended `partial_success`, for one. */
export interface GenerationWarningData {
	code: string;
	message: string;
	where?: string | null;
}

/** One entry of a batch run's `destinations`: where a distribution put the files (its Drive folder, say). */
export interface RunDestinationData {
	distribution_id?: string | null;
	distribution_type: PublicDistributionType;
	external_id: string;
	url?: string | null;
}

export interface RunData {
	id: string;
	document_id: string;
	workspace_id: string;
	kind: 'single' | 'batch';
	split_key: string | null;
	idempotency_key: string;
	status: RunStatus;
	file_count: number | null;
	progress: RunProgress | null;
	/** Batch only: counters such as `skipped_null`, `orphan` and `over_limit`. */
	generation_stats?: Record<string, number> | null;
	/** Batch only: one per distribution with a per-run container. */
	destinations?: RunDestinationData[];
	warnings?: GenerationWarningData[];
	processing_started_at?: string | null;
	finished_at?: string | null;
	/**
	 * `public-api.json` marks this optional, not required: the field can be omitted from the
	 * wire entirely (not just sent as `null`) — `flattenRun` must not assume either shape.
	 */
	output_result?: RenderedArtifact | null;
	error_code: string | null;
	error_message: string | null;
	created_at: string;
	updated_at: string;
	distributions: RunDistributionData[];
}
