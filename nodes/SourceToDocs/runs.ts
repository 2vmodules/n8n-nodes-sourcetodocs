/**
 * Reading a Run and its Split Children, and waiting for one to finish.
 *
 * Shared between Document → Generate (which creates the Run) and Run → Get
 * (which only reads one): both flatten a `RunData` the same way, and both may need
 * to list a batch's children.
 */
import type { IDataObject, INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { boundText, stripTrailingDots } from './text';
import {
	MIN_RETRY_WAIT_MS,
	isAuthenticationRateLimit,
	isRequestTimeout,
	sourceToDocsApiRequest,
	type SourceToDocsContext,
} from './transport';
import {
	TERMINAL_RUN_STATUSES,
	isGoogleDocsRunResult,
	type RunData,
	type RunDestinationData,
	type RunDistributionData,
} from './types';

/** `GET /runs/{run}`. */
export async function fetchRun(
	context: SourceToDocsContext,
	runId: string,
	timeoutMs?: number,
): Promise<RunData> {
	const { run } = (await sourceToDocsApiRequest.call(
		context,
		'GET',
		`/runs/${encodeURIComponent(runId)}`,
		{
			timeoutMs,
		},
	)) as {
		run: RunData;
	};
	return run;
}

/** `GET /runs/{run}/children`, in creation order — only valid for a `batch` run. A transient answer is retried within `budgetMs`. */
export async function fetchRunChildren(
	context: SourceToDocsContext,
	runId: string,
	budgetMs: number = DEFAULT_MAX_WAIT_SECONDS * 1000,
): Promise<RunData[]> {
	const { runs } = await getRetrying<{ runs: RunData[] }>(
		context,
		`/runs/${encodeURIComponent(runId)}/children`,
		budgetMs,
	);
	return runs;
}

/** One Run's Distribution, flattened to what a next node needs. */
function flattenDelivery(delivery: RunDistributionData, extended: boolean): IDataObject {
	return {
		id: delivery.id,
		type: delivery.distribution_type,
		status: delivery.status,
		result: delivery.result,
		error_code: delivery.error_code,
		error_message: delivery.error_message,
		...(extended ? { distribution_id: delivery.distribution_id ?? null } : {}),
	};
}

/** The first destination that has a link: a batch's Drive folder. `null` for a run with none (every single run). */
export function folderUrlOf(destinations: RunDestinationData[] | undefined): string | null {
	const found = (destinations ?? []).find(
		(destination) => typeof destination.url === 'string' && destination.url !== '',
	);
	return found?.url ?? null;
}

/**
 * One Run, flattened to the fields the next node needs at the top level: `file_url`,
 * `file_name` and `page_count` read out of `output_result`, whichever of the two Rendered
 * Artifact shapes it is (Google Slides' `slide_count` and Google Docs' `page_count` both land
 * on `page_count` here), plus the Run's own `file_count`/`progress` (always present on the
 * shape, `null` outside a batch). The whole Run still rides along under `run` (Simplify
 * strips that back out at the call site when it is on).
 *
 * `extended` (node version 1.1 and later) adds what a run says about itself: `warnings`,
 * `generation_stats`, `folder_url` (the batch's Drive folder, from `destinations`), `document_id`,
 * `processing_started_at`, `finished_at` and each delivery's `distribution_id`. Version 1 keeps
 * today's shape exactly.
 *
 * `output_result` is checked for `null` *and* `undefined`: `public-api.json` marks the
 * field optional, not required, so an omitted field reads as `undefined`, which `!== null`
 * would otherwise let through into `isGoogleDocsRunResult`'s `'document_url' in result`.
 */
export function flattenRun(run: RunData, extended = false): IDataObject {
	const output = run.output_result;
	let fileUrl: string | null = null;
	let fileName: string | null = null;
	let pageCount: number | null = null;

	if (output !== null && output !== undefined) {
		if (isGoogleDocsRunResult(output)) {
			fileUrl = output.document_url;
			fileName = output.document_name;
			pageCount = output.page_count;
		} else {
			fileUrl = output.presentation_url;
			fileName = output.presentation_name;
			pageCount = output.slide_count;
		}
	}

	return {
		run_id: run.id,
		status: run.status,
		kind: run.kind,
		split_key: run.split_key,
		file_url: fileUrl,
		file_name: fileName,
		page_count: pageCount,
		file_count: run.file_count,
		progress: run.progress,
		deliveries: run.distributions.map((delivery) => flattenDelivery(delivery, extended)),
		error_code: run.error_code,
		error_message: run.error_message,
		...(extended
			? {
					warnings: run.warnings ?? [],
					generation_stats: run.generation_stats ?? null,
					folder_url: folderUrlOf(run.destinations),
					document_id: run.document_id ?? null,
					processing_started_at: run.processing_started_at ?? null,
					finished_at: run.finished_at ?? null,
				}
			: {}),
		run,
	};
}

/**
 * A finished batch's children, each flattened as {@link flattenRun} plus the batch's own
 * `batch_run_id`, `file_count` and `progress` — overriding each child's own (always `null`)
 * copies of the last two with the root's real counters.
 */
export function flattenBatchChildren(
	root: RunData,
	children: RunData[],
	extended = false,
): IDataObject[] {
	return children.map((child) => ({
		...flattenRun(child, extended),
		batch_run_id: root.id,
		file_count: root.file_count,
		progress: root.progress,
		// The batch owns its folder and its counters; a child has neither.
		...(extended
			? {
					folder_url: folderUrlOf(root.destinations),
					generation_stats: root.generation_stats ?? null,
				}
			: {}),
	}));
}

/**
 * A finished batch's own items: its children, flattened — unless there are none, in which case
 * the batch itself, flattened, is the one item returned. A Driver with no key at all, every
 * key blank, or a stale-schema miss all finish the batch `succeeded` with `file_count: 0` and no
 * children; returning zero items then would silently end the workflow with nothing to show why.
 */
export function flattenBatchResult(
	root: RunData,
	children: RunData[],
	extended = false,
): IDataObject[] {
	if (children.length === 0) {
		return [flattenRun(root, extended)];
	}
	return flattenBatchChildren(root, children, extended);
}

/** `item` without its `run` key — Simplify's "on" behaviour, applied after flattening. */
function withoutRun(item: IDataObject): IDataObject {
	const copy = { ...item };
	delete copy.run;
	return copy;
}

/**
 * Flattened items as Simplify left them: the full `run` object dropped from each when it is on
 * (the default), kept when it is off. Shared by Document → Generate and Run → Get — both
 * flatten a `RunData` through {@link flattenRun}/{@link flattenBatchResult}, and both offer the
 * same Simplify boolean over the result.
 */
export function applySimplify(items: IDataObject[], simplify: boolean): IDataObject[] {
	return simplify ? items.map(withoutRun) : items;
}

export interface WaitForTerminalRunOptions {
	maxWaitMs: number;
	pollEveryMs: number;
}

/** Seams a test replaces: how long to wait, how to re-read the Run, and the clock — no real timers needed. */
export interface WaitForTerminalRunDeps {
	fetchRun?: (runId: string, timeoutMs: number) => Promise<RunData>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface WaitForTerminalRunResult {
	run: RunData;
	timedOut: boolean;
}

/** The minimum Poll Every and the bounds on Max Wait, enforced in code: a `typeOptions`
 * `minValue`/`maxValue` is a UI-only guard — an expression bypasses it entirely. */
const MIN_POLL_EVERY_SECONDS = 2;
const MAX_WAIT_SECONDS_CAP = 3600;

/**
 * The least a poll is given to answer, however little of Max Wait is left: a poll started
 * with no budget left still needs a real timeout, and a zero would mean none at all. A wait ends
 * within Max Wait plus one poll timeout.
 */
const MIN_POLL_TIMEOUT_MS = 5000;

/** What Max Wait and Poll Every are when the parameter is empty or not there (the field defaults). */
export const DEFAULT_MAX_WAIT_SECONDS = 300;
export const DEFAULT_POLL_EVERY_SECONDS = 5;

/**
 * `maxWait`/`pollEvery`, as the node's parameters gave them (seconds, possibly from an
 * expression), clamped to sane bounds and converted to the milliseconds
 * {@link waitForTerminalRun} takes: Poll Every is never under {@link MIN_POLL_EVERY_SECONDS} nor
 * over {@link MAX_WAIT_SECONDS_CAP}, and Max Wait is never under one poll interval (so there is
 * always at least one poll) nor over {@link MAX_WAIT_SECONDS_CAP}. Both must be finite: see
 * {@link resolveWaitOptions} for what an expression may hand over.
 */
export function clampWaitOptions(
	maxWaitSeconds: number,
	pollEverySeconds: number,
): WaitForTerminalRunOptions {
	const pollEveryClamped = Math.min(
		Math.max(pollEverySeconds, MIN_POLL_EVERY_SECONDS),
		MAX_WAIT_SECONDS_CAP,
	);
	const maxWaitClamped = Math.min(Math.max(maxWaitSeconds, pollEveryClamped), MAX_WAIT_SECONDS_CAP);
	return { pollEveryMs: pollEveryClamped * 1000, maxWaitMs: maxWaitClamped * 1000 };
}

/**
 * One wait parameter as seconds. `undefined`, `null` and an empty (or blank) string take
 * `fallback`: that is what an expression resolving to nothing gives. Anything else goes through
 * `Number()`, and a result that is not finite (`NaN`, `Infinity`, text) is refused, naming the
 * parameter. `Math.max(NaN, 2)` is `NaN`, which no later clamp can repair.
 */
function secondsFrom(node: INode, parameter: string, raw: unknown, fallback: number): number {
	if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
		return fallback;
	}
	const seconds = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
	if (!Number.isFinite(seconds)) {
		const shown =
			typeof raw === 'string'
				? JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}...` : raw)
				: `a ${typeof raw}`;
		throw new NodeOperationError(node, `'${parameter}' is not a number: ${shown}`, {
			description: `'${parameter}' must be a number of seconds, for example ${parameter.startsWith('Max') ? DEFAULT_MAX_WAIT_SECONDS : DEFAULT_POLL_EVERY_SECONDS}. Leave it empty for the default. Nothing was sent.`,
		});
	}
	return seconds;
}

/** Max Wait and Poll Every as the node holds them: converted, refused when not a number, then clamped. */
export function resolveWaitOptions(
	node: INode,
	rawMaxWait: unknown,
	rawPollEvery: unknown,
): WaitForTerminalRunOptions {
	return clampWaitOptions(
		secondsFrom(node, 'Max Wait (Seconds)', rawMaxWait, DEFAULT_MAX_WAIT_SECONDS),
		secondsFrom(node, 'Poll Every (Seconds)', rawPollEvery, DEFAULT_POLL_EVERY_SECONDS),
	);
}

/**
 * Decorates a thrown error with the Run's id — in its `context` (for a `continueOnFail` item to
 * read structured) and appended to its `description` (so the message itself says it, and
 * Retry On Fail does not read as "start a fresh run"). Idempotent: re-decorating with the
 * same id is a no-op, so an error that already carries it (e.g. re-thrown through more than one
 * catch) is not annotated twice. Anything other than a proper node error is returned unchanged —
 * there is nothing on a plain `Error` to attach `context` to in a way that survives.
 */
export function withRunId<T extends Error>(error: T, runId: string): T {
	if (!(error instanceof NodeOperationError || error instanceof NodeApiError)) {
		return error;
	}
	if (error.context.runId === runId) {
		return error;
	}
	error.context.runId = runId;
	const mention = `Run ID: ${runId}`;
	// Trims a trailing full stop first (same convention as transport/index.ts's
	// `describeFailure`), so a description that already ends a sentence — a failed batch's own
	// child summary, for one — does not read "...missing).. Run ID: x" with two periods.
	const existing =
		error.description === undefined
			? undefined
			: stripTrailingDots(boundText(error.description, 2000));
	error.description = existing ? `${existing}. ${mention}` : mention;
	return error;
}

/** Whether the execution was stopped: the cancel signal n8n hands the node has fired. */
function isCancelled(context: SourceToDocsContext | undefined): boolean {
	return (
		context !== undefined &&
		'getExecutionCancelSignal' in context &&
		context.getExecutionCancelSignal()?.aborted === true
	);
}

/**
 * A 429, a 5xx, a request that timed out, or a dropped connection (an error with no numeric HTTP
 * status: `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`…) — worth retrying rather than failing the whole
 * wait. A GET is always safe to repeat. A stopped execution is never retried.
 */
function isTransientPollError(error: unknown, cancelled: boolean): boolean {
	if (cancelled || !(error instanceof NodeApiError)) {
		return false;
	}
	if (isRequestTimeout(error)) {
		return true;
	}
	// A refused token stays refused: waiting would spend the whole budget on a wrong token.
	if (isAuthenticationRateLimit(error)) {
		return false;
	}
	const raw = error.httpCode as unknown;
	const code = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw);
	return Number.isNaN(code) || code === 429 || (code >= 500 && code < 600);
}

/** The `Retry-After` the transport stashed on the error's `context`, when there was one. */
function retryAfterMsOf(error: unknown): number | undefined {
	if (error instanceof NodeApiError && typeof error.context.retryAfterMs === 'number') {
		return error.context.retryAfterMs;
	}
	return undefined;
}

/**
 * One poll's `GET`, retried on a transient answer (429, 5xx, a timeout, a dropped connection) as
 * long as the wait's own budget allows: honours `Retry-After` when the answer carried
 * one, else waits another `pollEveryMs` before trying again. A non-transient error is re-thrown
 * carrying the Run's id (`withRunId`) so it is never mistaken for "no run was ever started". A
 * transient one with no budget left is not an error: `undefined` comes back and the caller reports
 * the run it already holds as timed out.
 */
async function fetchRunRetrying(
	isCancelledNow: () => boolean,
	doFetchRun: (id: string, timeoutMs: number) => Promise<RunData>,
	doSleep: (ms: number) => Promise<void>,
	now: () => number,
	runId: string,
	pollEveryMs: number,
	remainingMs: number,
	addElapsed: (ms: number) => void,
): Promise<RunData | undefined> {
	const startedAt = now();
	try {
		const run = await doFetchRun(runId, Math.max(remainingMs, MIN_POLL_TIMEOUT_MS));
		addElapsed(Math.max(now() - startedAt, 0));
		return run;
	} catch (error) {
		const tookMs = Math.max(now() - startedAt, 0);
		addElapsed(tookMs);
		const leftMs = remainingMs - tookMs;
		if (!isTransientPollError(error, isCancelledNow())) {
			throw withRunId(error as Error, runId);
		}
		if (leftMs <= 0) {
			return undefined;
		}
		// A `Retry-After` of 0 (or a fraction of a second) must not turn the retry into a hot loop:
		// the wait is at least MIN_RETRY_WAIT_MS, but never more than what is left of Max Wait.
		const waitMs = Math.min(
			Math.max(retryAfterMsOf(error) ?? pollEveryMs, MIN_RETRY_WAIT_MS),
			leftMs,
		);
		await doSleep(waitMs);
		addElapsed(waitMs);
		return fetchRunRetrying(
			isCancelledNow,
			doFetchRun,
			doSleep,
			now,
			runId,
			pollEveryMs,
			leftMs - waitMs,
			addElapsed,
		);
	}
}

/**
 * A `GET` that is not a poll — the document read, a batch's children — retried like one: on
 * a transient answer it waits the `Retry-After` the API named (at least 1 s, never past what is
 * left of `budgetMs`) and asks again. Out of budget, or any other error, the error is thrown.
 */
export async function getRetrying<T>(
	context: SourceToDocsContext,
	endpoint: string,
	budgetMs: number,
): Promise<T> {
	let leftMs = budgetMs;
	for (;;) {
		const startedAt = Date.now();
		try {
			return (await sourceToDocsApiRequest.call(context, 'GET', endpoint)) as T;
		} catch (error) {
			leftMs -= Math.max(Date.now() - startedAt, 0);
			if (!isTransientPollError(error, isCancelled(context)) || leftMs <= 0) {
				throw error instanceof NodeApiError
					? error
					: new NodeOperationError(context.getNode(), error as Error);
			}
			const waitMs = Math.min(
				Math.max(retryAfterMsOf(error) ?? MIN_RETRY_WAIT_MS, MIN_RETRY_WAIT_MS),
				leftMs,
			);
			await sleep(waitMs, abortSignalOf(context));
			leftMs -= waitMs;
		}
	}
}

/** The cancel signal n8n hands the node for this execution, when there is one. */
export function abortSignalOf(context: SourceToDocsContext): AbortSignal | undefined {
	return 'getExecutionCancelSignal' in context ? context.getExecutionCancelSignal() : undefined;
}

/**
 * Polls `GET /runs/{run}` every `pollEveryMs` until `status` is terminal or `maxWaitMs` has
 * elapsed. Elapsed time is an explicit counter, not the wall clock: each
 * ordinary poll adds `pollEveryMs`, and each poll's own request latency and any transient-retry
 * wait add their real durations on top — so a stubbed `sleep`/`now` makes the common
 * path instant and deterministic in tests, while production still counts the time a slow or
 * retried answer actually took against the budget.
 *
 * A transient answer (429, 5xx, a timeout, a dropped connection) on the poll that has no budget left is
 * not an error: the run the node holds is returned as timed out. Every wait ends when the execution is
 * stopped (the cancel signal).
 *
 * `initialRun` is the Run as the caller already has it (the `201` body, or an earlier poll) —
 * read once before the first sleep, so a Run that is already terminal polls zero times.
 */
export async function waitForTerminalRun(
	context: SourceToDocsContext,
	runId: string,
	initialRun: RunData,
	{ maxWaitMs, pollEveryMs }: WaitForTerminalRunOptions,
	deps: WaitForTerminalRunDeps = {},
): Promise<WaitForTerminalRunResult> {
	const doFetchRun =
		deps.fetchRun ?? ((id: string, timeoutMs: number) => fetchRun(context, id, timeoutMs));
	const signal = abortSignalOf(context);
	const doSleep = deps.sleep ?? ((ms: number) => sleep(ms, signal));
	const now = deps.now ?? Date.now;

	let run = initialRun;
	let elapsedMs = 0;
	const addElapsed = (ms: number) => {
		elapsedMs += ms;
	};

	while (!TERMINAL_RUN_STATUSES.has(run.status)) {
		if (elapsedMs >= maxWaitMs) {
			return { run, timedOut: true };
		}
		await doSleep(pollEveryMs);
		elapsedMs += pollEveryMs;
		const polled = await fetchRunRetrying(
			() => isCancelled(context),
			doFetchRun,
			doSleep,
			now,
			runId,
			pollEveryMs,
			Math.max(maxWaitMs - elapsedMs, 0),
			addElapsed,
		);
		if (polled === undefined) {
			// A transient answer with the budget spent: the run is still going, as far as we know.
			return { run, timedOut: true };
		}
		run = polled;
	}

	return { run, timedOut: false };
}
