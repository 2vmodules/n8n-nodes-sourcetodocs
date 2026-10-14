/**
 * Starting a Run so that a retry never starts a second one.
 *
 * Three parts: the key the node sends when the person set none ({@link automaticIdempotencyKey}),
 * the small retry budget of the start `POST` ({@link startRun}), and the reading of a conflict
 * that names the Run already started ({@link existingRunIdOf}).
 */
import { createHash } from 'node:crypto';

import type { IDataObject, IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { UUID_PATTERN } from './ids';
import {
	MIN_RETRY_WAIT_MS,
	errorCodeFromErrors,
	isAuthenticationRateLimit,
	isRequestTimeout,
	sourceToDocsApiRequest,
	transportLimits,
} from './transport';
import type { RunData } from './types';

/** The `errors.code` the API answers when a Run with this idempotency key exists. */
export const IDEMPOTENCY_CONFLICT_CODE = 'run_idempotency_conflict';

/** The API refuses a key longer than this (`max:255`). */
const MAX_KEY_LENGTH = 255;

/** Tries of the start POST, the first included. */
export const START_TRIES = 3;

/** The least a retried POST is given to answer, whatever is left of the budget (as for polls). */
const MIN_RETRY_TIMEOUT_MS = 5000;

/** The first `length` characters of `value`; keeps the whole key under the API's limit whatever the ids look like. */
function cut(value: string, length: number): string {
	return value.length > length ? value.slice(0, length) : value;
}

/** The start request an automatic key may be derived from: the document path and the body (without any key). */
export interface StartRequest {
	documentPath: string;
	body: IDataObject;
}

/** `value` as JSON with every object's keys sorted, so equal requests serialise to equal text. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry ?? null)).join(',')}]`;
	}
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort()
			.filter((name) => record[name] !== undefined)
			.map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** The last part of the AI tool variant's key: 32 hex characters (128 bits of SHA-256) of the document path and the body without its key. */
function requestHash(request: StartRequest): string {
	const rest = { ...request.body };
	delete rest.idempotency_key;
	return createHash('sha256')
		.update(`${request.documentPath}\n${canonicalJson(rest)}`)
		.digest('hex')
		.slice(0, 32);
}

/**
 * The key Generate sends when Idempotency Key is empty: `n8n:<instance>:<workflow>:<execution>:<node>:<last part>`.
 *
 * Measured on n8n-core 2.36.7: the execution id, the node id and the run index (`$runIndex` of
 * `getWorkflowDataProxy`) are the same on every Retry On Fail try of one node run, and each differs
 * for another run of the node in the execution (the run index), for another execution (the execution
 * id) and for another node (the node id). The instance and workflow ids are there because execution
 * ids restart at 1 on another n8n, and a copied workflow keeps its node ids: two n8n instances on
 * one workspace must not adopt each other's runs. Each part is cut, so the key never passes 255
 * characters.
 *
 * The exception is the AI tool variant called in process (`isToolExecution()`: n8n-core's
 * `makeHandleToolInvocation`, used by the MCP Server Trigger and other in-process consumers), which
 * raises the run index on every Retry On Fail try. There the last part is a hash of the request (the
 * document path and the body without the key) instead: it is the same on every try, and differs for a
 * different call. Two identical calls in one execution therefore share one run.
 *
 * `undefined` when the engine gives no execution id or run index: a key that does not tell one
 * execution from another would make a later execution adopt an old run, so none is sent.
 */
export function automaticIdempotencyKey(
	context: IExecuteFunctions,
	request: StartRequest,
): string | undefined {
	const executionId = context.getExecutionId() as string | undefined;
	const runIndex = (context.getWorkflowDataProxy(0) as unknown as { $runIndex?: unknown })
		.$runIndex;
	if (typeof executionId !== 'string' || executionId === '' || typeof runIndex !== 'number') {
		return undefined;
	}
	let instanceId = '';
	try {
		instanceId = context.getInstanceId();
	} catch {
		// an engine without an instance id: the other parts still tell the executions apart
	}
	const inProcessTool = typeof context.isToolExecution === 'function' && context.isToolExecution();
	const key = [
		'n8n',
		cut(instanceId, 16),
		cut(String(context.getWorkflow().id ?? ''), 40),
		cut(executionId, 40),
		cut(String(context.getNode().id), 64),
		inProcessTool ? requestHash(request) : String(runIndex),
	].join(':');
	return cut(key, MAX_KEY_LENGTH);
}

/**
 * How old a run may be and still be adopted under an automatic key: 6 h. n8n's Retry On Fail makes at
 * most 5 tries, each of which may wait the 3600 s Max Wait cap, with at most 5 s between tries: a
 * retry of the same node run is never further from its first start than that. An older run under the
 * same automatic key is a repeat of the key after an n8n reset or migration (execution ids restart),
 * not a retry. A key the person set adopts a run of any age.
 */
export const AUTOMATIC_KEY_ADOPTION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Whether a run created at `createdAt` is older than the adoption window. An unparseable date is not: it is adopted. */
export function isOlderThanAdoptionWindow(createdAt: unknown, now: number = Date.now()): boolean {
	if (typeof createdAt !== 'string') {
		return false;
	}
	const created = Date.parse(createdAt);
	return !Number.isNaN(created) && now - created > AUTOMATIC_KEY_ADOPTION_WINDOW_MS;
}

/** The run id a 422 `run_idempotency_conflict` names in `errors.run_id`, when it is a UUID; else `undefined`. */
export function existingRunIdOf(error: unknown): string | undefined {
	if (!(error instanceof NodeApiError)) {
		return undefined;
	}
	const errors = (error.errorResponse as { errors?: unknown } | undefined)?.errors;
	if (errorCodeFromErrors(errors) !== IDEMPOTENCY_CONFLICT_CODE) {
		return undefined;
	}
	const raw = (errors as Record<string, unknown>).run_id;
	const runId = Array.isArray(raw) ? raw[0] : raw;
	return typeof runId === 'string' && UUID_PATTERN.test(runId.trim()) ? runId.trim() : undefined;
}

/**
 * The key for a new run after the run `failedRunId`, which held `key` and ended `failed`: `<key>:after:<run id>`.
 * Deterministic, so every later try derives the same one. Over 255 characters the end of `key` is cut, never
 * the run id.
 */
export function keyAfterFailedRun(key: string, failedRunId: string): string {
	const suffix = `:after:${failedRunId}`;
	return `${cut(key, MAX_KEY_LENGTH - suffix.length)}${suffix}`;
}

/** The `errors.run_id` string of an API answer, whatever its code and whether or not it is a UUID. */
export function runIdNamedBy(errors: unknown): string | undefined {
	if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) {
		return undefined;
	}
	const raw = (errors as Record<string, unknown>).run_id;
	const runId = Array.isArray(raw) ? raw[0] : raw;
	return typeof runId === 'string' && runId !== '' ? runId : undefined;
}

/**
 * Whether the start POST that failed with `error` may be sent again.
 *
 * - a 429 created no run: always, except the one that refuses the 'API Token' ({@link isAuthenticationRateLimit});
 * - a 5xx, a network error (no HTTP status) or a timeout may have created one: only with a key, so that
 *   the retry gets the conflict and adopts the run instead of making a second;
 * - a 4xx other than 429, and any error that is not an API one, never.
 */
function isRetryable(error: unknown, hasKey: boolean): boolean {
	if (!(error instanceof NodeApiError)) {
		return false;
	}
	if (isRequestTimeout(error)) {
		return hasKey;
	}
	// A refused token stays refused: a retry would be refused the same way.
	if (isAuthenticationRateLimit(error)) {
		return false;
	}
	const raw = error.httpCode as unknown;
	const status = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw);
	if (status === 429) {
		return true;
	}
	// No numeric HTTP status at all means the answer never came: a refused or reset connection.
	return hasKey && (Number.isNaN(status) || (status >= 500 && status < 600));
}

/** How long to wait before the next try: the `Retry-After` the answer carried (never under 1 s), else 1 s, then 2 s. */
function waitBeforeRetryMs(error: unknown, failedTries: number): number {
	const named = error instanceof NodeApiError ? error.context.retryAfterMs : undefined;
	if (typeof named === 'number') {
		return Math.max(named, MIN_RETRY_WAIT_MS);
	}
	return transportLimits.startRetryBackoffMs * 2 ** (failedTries - 1);
}

/** `error` as a node error: an API or node error stays as it is, anything else is wrapped. */
function asNodeError(node: INode, error: unknown): NodeApiError | NodeOperationError {
	return error instanceof NodeApiError || error instanceof NodeOperationError
		? error
		: new NodeOperationError(node, error as Error);
}

/**
 * `POST /documents/{document}/runs`, with the node's one small retry budget: at most {@link START_TRIES}
 * tries, and no retry that would end after `budgetMs` (Max Wait). A 429 honours `Retry-After`; when the
 * wait it names does not fit what is left of the budget the 429 is the error. The same `body`, key
 * included, is sent every time. The last error is thrown as it came.
 */
export async function startRun(
	context: IExecuteFunctions,
	documentPath: string,
	body: IDataObject,
	budgetMs: number,
): Promise<RunData> {
	const startedAt = Date.now();
	const hasKey = typeof body.idempotency_key === 'string';
	for (let tries = 1; ; tries++) {
		try {
			const options =
				tries === 1
					? { body }
					: {
							body,
							timeoutMs: Math.max(budgetMs - (Date.now() - startedAt), MIN_RETRY_TIMEOUT_MS),
						};
			const { run } = (await sourceToDocsApiRequest.call(
				context,
				'POST',
				`/documents/${documentPath}/runs`,
				options,
			)) as {
				run: RunData;
			};
			return run;
		} catch (error) {
			// A stopped execution ends the retries: the aborted request has no HTTP status, which would read as a dropped connection.
			if (
				tries >= START_TRIES ||
				context.getExecutionCancelSignal?.()?.aborted === true ||
				!isRetryable(error, hasKey)
			) {
				throw asNodeError(context.getNode(), error);
			}
			const waitMs = waitBeforeRetryMs(error, tries);
			if (Date.now() - startedAt + waitMs > budgetMs) {
				throw asNodeError(context.getNode(), error);
			}
			await sleep(waitMs, context.getExecutionCancelSignal?.());
		}
	}
}
