import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import {
	AUTHENTICATION_RATE_LIMITED_CODE,
	BODY_TOO_LARGE_URL,
	MAX_LISTED_ENTRIES,
	RUN_ERROR_CODES_URL,
	codeLink,
	SOURCE_TOO_LARGE_URL,
	boundText,
	stripTrailingDots,
} from '../text';

/** The credential every request is authenticated with. */
export const CREDENTIAL_NAME = 'sourceToDocsApi';

/** The contexts a request can run in: an operation, or a dropdown being loaded. */
export type SourceToDocsContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * What the Public API wraps every answer in.
 *
 * A success is `{ success: true, data }`. A failure is `{ success: false, category, message,
 * errors }`, where `errors` is `[]` when there is nothing to say, `{ code: ['some_code'] }` for a
 * business refusal, and `{ field: ['message'] }` for a validation failure.
 */
export interface ApiEnvelope<TData = unknown> {
	success: boolean;
	data?: TData;
	category?: string;
	message?: string;
	errors?: unknown;
}

export interface SourceToDocsRequestOptions {
	body?: IDataObject;
	/** A shorter timeout for this one request (a poll bounded by what is left of Max Wait); never longer than the limit. */
	timeoutMs?: number;
}

/**
 * How long one request may take, in milliseconds. It is a constant in production; it is an
 * object only so an engine test can shorten it (a 30 s wait would make the suite crawl). There is
 * no parameter for it on purpose.
 */
export const transportLimits = {
	requestTimeoutMs: 30_000,
	/** The wait before the first retry of the start POST when the answer named none; the next doubles it. */
	startRetryBackoffMs: 1000,
};

/** The least a retry waits after a transient answer, whatever `Retry-After` says: a `Retry-After` of 0 must not become a hot loop. */
export const MIN_RETRY_WAIT_MS = 1000;

/** Hosts a plain `http:` Base URL is allowed to point at: the machine running n8n itself. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The parts of the answer the transport looks at — `headers` only for `Retry-After`. */
interface HttpAnswer {
	statusCode: number;
	body: unknown;
	headers?: IDataObject;
}

/** A request body over this many MB is refused with a plain-text 413 before it reaches the app. */
const MAX_REQUEST_BODY_MB = 40;

/** The API's own cap on a start body, in MiB: about 15 000 ordinary rows. */
const MAX_BODY_MIB = 2;

/**
 * The one way the node talks to the Public API.
 *
 * Joins the credential's Base URL with `endpoint`, sends the request with the credential's
 * Bearer token, and returns the envelope's `data`. Any answer that is not a 2xx success envelope
 * becomes a `NodeApiError` whose message is the API's own `message` and whose description carries
 * `errors.code` and `category`.
 */
export async function sourceToDocsApiRequest<TData = IDataObject>(
	this: SourceToDocsContext,
	method: IHttpRequestMethods,
	endpoint: string,
	{ body, timeoutMs }: SourceToDocsRequestOptions = {},
): Promise<TData> {
	const node = this.getNode();
	const credentials = await this.getCredentials<{ baseUrl?: string }>(CREDENTIAL_NAME);
	const baseUrl = (credentials.baseUrl ?? '').trim();

	if (baseUrl === '') {
		throw new NodeOperationError(node, "The SourceToDocs credential has no 'Base URL'", {
			description:
				"Open the credential and set 'Base URL' to the root of the Public API, https://app.sourcetodocs.com/api/public/v1 for the production app.",
		});
	}

	assertSecureBaseUrl(node, baseUrl);

	const options: IHttpRequestOptions = {
		method,
		url: joinUrl(baseUrl, endpoint),
		headers: { Accept: 'application/json' },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// The Public API never redirects. A redirect is a misconfigured Base URL, and following it
		// would re-send the bearer token to wherever it points.
		disableFollowRedirect: true,
		timeout: Math.min(
			timeoutMs ?? transportLimits.requestTimeoutMs,
			transportLimits.requestTimeoutMs,
		),
	};
	if (body !== undefined) {
		options.body = body;
	}

	let answer: HttpAnswer;
	try {
		answer = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as HttpAnswer;
	} catch (error) {
		throw describeTimeout(node, error, options.timeout);
	}

	return unwrapEnvelope(node, answer.statusCode, answer.body, answer.headers) as TData;
}

/**
 * Refuses a Base URL the token must not be sent to: anything but `https:`, with `http:` only
 * for the machine n8n runs on. Runs before every request, so execute, load options and list search
 * are all covered. The credential's own Test cannot run it: it sends the token to the Base URL.
 */
export function assertSecureBaseUrl(node: INode, baseUrl: string): void {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new NodeOperationError(
			node,
			"The 'Base URL' of the SourceToDocs credential is not a valid URL",
			{
				description:
					"Set 'Base URL' to the root of the Public API, https://app.sourcetodocs.com/api/public/v1 for the production app.",
			},
		);
	}
	if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
		return;
	}
	throw new NodeOperationError(
		node,
		"The 'Base URL' of the SourceToDocs credential must use https",
		{
			description:
				"The 'API Token' is sent to 'Base URL' with every request, so a plain http:// address would send it unencrypted. Use an https:// address.",
		},
	);
}

/** A request that ran out of time becomes an error that says so; any other error passes through. */
function describeTimeout(node: INode, error: unknown, timeoutMs: number | undefined): unknown {
	if (!isTimeout(error)) {
		return error;
	}
	const seconds = Math.max(Math.round((timeoutMs ?? transportLimits.requestTimeoutMs) / 1000), 1);
	// Built from a plain object, not the axios error: n8n would read its code and replace the message.
	const timeout = new NodeApiError(node, { timedOut: true, timeoutMs } as JsonObject, {
		message: `The SourceToDocs API did not answer within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
		description: "Check that the 'Base URL' of the credential is reachable, or try again shortly.",
	});
	timeout.context.timedOut = true;
	return timeout;
}

/** An axios timeout: code `ECONNABORTED` or `ETIMEDOUT`, on the error or on its cause. */
function isTimeout(error: unknown): boolean {
	const codes = new Set(['ECONNABORTED', 'ETIMEDOUT']);
	const candidates = [error, (error as { cause?: unknown } | undefined)?.cause];
	return candidates.some((candidate) => {
		const code = (candidate as { code?: unknown } | undefined)?.code;
		return typeof code === 'string' && codes.has(code);
	});
}

/**
 * Whether `error` is the 429 that refuses an 'API Token' for too many wrong tries from one address.
 * Waiting does not help it: the token itself is what to check, so no retry loop repeats it.
 */
export function isAuthenticationRateLimit(error: unknown): boolean {
	return (
		error instanceof NodeApiError &&
		errorCodeFromErrors((error.errorResponse as { errors?: unknown } | undefined)?.errors) ===
			AUTHENTICATION_RATE_LIMITED_CODE
	);
}

/** Whether `error` is the timeout error {@link sourceToDocsApiRequest} raises. */
export function isRequestTimeout(error: unknown): boolean {
	return error instanceof NodeApiError && error.context.timedOut === true;
}

/** `baseUrl` and `endpoint` joined with exactly one slash between them. */
export function joinUrl(baseUrl: string, endpoint: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	return `${base}${path}`;
}

/**
 * The app's own origin (scheme + host + port), derived from the credential's Base URL.
 *
 * The Base URL points at the Public API (`.../api/public/v1`); the app's own pages — a
 * document's URL among them — live at the same host's root. Falls back to the production
 * app when the Base URL cannot be parsed as a URL at all (so a picker never throws over this).
 */
export function appOriginFrom(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return 'https://app.sourcetodocs.com';
	}
}

/**
 * The envelope's `data` for a 2xx success; a `NodeApiError` for everything else.
 *
 * Exported so the mapping can be tested without an HTTP layer. `headers` is only read for
 * `Retry-After` on a failure, so a poll that hits a transient answer can be retried within
 * budget — omitting it changes nothing else.
 */
export function unwrapEnvelope(
	node: INode,
	statusCode: number,
	body: unknown,
	headers?: IDataObject,
): unknown {
	const httpCode = String(statusCode);
	if (statusCode >= 300 && statusCode < 400) {
		throw redirectError(node, statusCode, httpCode, body, headers);
	}
	const envelope = asEnvelope(body);
	const isSuccessStatus = statusCode >= 200 && statusCode < 300;

	if (envelope === undefined) {
		const error = new NodeApiError(node, { statusCode, body } as JsonObject, {
			...envelopeLessFailure(statusCode, httpCode),
			httpCode,
		});
		attachRetryAfter(error, headers);
		throw error;
	}

	if (isSuccessStatus && envelope.success === true) {
		return envelope.data;
	}

	const fallback = isSuccessStatus
		? `The SourceToDocs API answered HTTP ${httpCode} without success`
		: `The SourceToDocs API answered HTTP ${httpCode}`;
	const known = knownRefusal(errorCodeFromErrors(envelope.errors));
	const serverMessage =
		typeof envelope.message === 'string' ? boundText(envelope.message) : undefined;
	const error = new NodeApiError(node, envelope as unknown as JsonObject, {
		message: known?.message ?? serverMessage ?? fallback,
		description: describeFailure(
			envelope,
			statusCode,
			known === undefined ? undefined : { ...known, serverMessage },
		),
		httpCode,
	});
	attachRetryAfter(error, headers);
	throw error;
}

/** A 3xx is never followed, so it is reported: with its status and where it pointed. */
function redirectError(
	node: INode,
	statusCode: number,
	httpCode: string,
	body: unknown,
	headers: IDataObject | undefined,
): NodeApiError {
	const location = headers?.location ?? headers?.Location;
	const host = typeof location === 'string' ? hostOf(location) : undefined;
	const where =
		host ?? (typeof location === 'string' ? 'another path on the same host' : 'another address');
	return new NodeApiError(node, { statusCode, body } as JsonObject, {
		message: `The SourceToDocs API answered HTTP ${httpCode}: a redirect to ${where}`,
		description:
			"The node does not follow redirects, so the 'API Token' is never sent anywhere else. Set 'Base URL' of the credential to the API root, https://<your host>/api/public/v1.",
		httpCode,
	});
}

/** The host of a `Location` value; `undefined` for a relative one (the same host) or one that is not a URL. */
function hostOf(location: string): string | undefined {
	try {
		return new URL(location).host || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The message/description for an answer with no JSON envelope at all — mapped by status,
 * since "no envelope" does not always mean "wrong Base URL": a body over the limit and an
 * unreachable proxy each answer in plain text too, and blaming the Base URL for those points a
 * reader at the wrong cause.
 */
function envelopeLessFailure(
	statusCode: number,
	httpCode: string,
): { message: string; description: string } {
	if (statusCode === 413) {
		return {
			message: 'The SourceToDocs API answered HTTP 413: the request body is over its limit',
			description: `The rows are too large to send in one run: the web server in front of the API refuses a request body over ${MAX_REQUEST_BODY_MB} MB, and the API itself refuses one over ${MAX_BODY_MIB} MiB. Send fewer rows per run: split them over several runs, or use a split document. See ${BODY_TOO_LARGE_URL}`,
		};
	}
	if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
		return {
			message: `The SourceToDocs API answered HTTP ${httpCode}: the API is unreachable`,
			description: 'The server in front of the application could not reach it. Try again shortly.',
		};
	}
	return {
		message: `The SourceToDocs API answered HTTP ${httpCode} without its JSON envelope`,
		description:
			"Check the 'Base URL' of the credential: it must point at the root of the Public API, /api/public/v1, and not at the application itself.",
	};
}

/** Milliseconds a `Retry-After` header names, or `undefined` when absent or not a plain number of seconds. */
function retryAfterMsFromHeaders(headers: IDataObject | undefined): number | undefined {
	if (headers === undefined) {
		return undefined;
	}
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (typeof raw !== 'string' && typeof raw !== 'number') {
		return undefined;
	}
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return undefined;
	}
	return seconds * 1000;
}

/** Stashes a `Retry-After` answer on the error's own `context`, for `waitForTerminalRun` to read. */
function attachRetryAfter(error: NodeApiError, headers: IDataObject | undefined): void {
	const retryAfterMs = retryAfterMsFromHeaders(headers);
	if (retryAfterMs !== undefined) {
		error.context.retryAfterMs = retryAfterMs;
	}
}

/** The body as an envelope when it has the envelope's shape, else `undefined`. */
function asEnvelope(body: unknown): ApiEnvelope | undefined {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return undefined;
	}
	if (typeof (body as ApiEnvelope).success !== 'boolean') {
		return undefined;
	}
	return body as ApiEnvelope;
}

/** What the node says itself about the two refusals that name a limit; the API's own text goes after it. */
interface KnownRefusal {
	message: string;
	step: string;
}

function knownRefusal(code: string | undefined): KnownRefusal | undefined {
	if (code === 'request_body_too_large') {
		return {
			message: `The rows are too large to send in one run: the request is over the API's ${MAX_BODY_MIB} MiB limit`,
			step: `Nothing was started. About 15 000 ordinary rows fit in one run. Send fewer rows per run: split them over several runs, for example with a Loop Over Items node, or use a split document. See ${BODY_TOO_LARGE_URL}`,
		};
	}
	if (code === 'source_too_large') {
		return {
			message: 'A Data Set has more rows than one run may hold',
			step: `Nothing was started. Send fewer rows per run: filter the rows before this node, split them over several runs, or use a split document. If the document is a split document, its source table is too big: reduce the table the split reads. See ${SOURCE_TOO_LARGE_URL}`,
		};
	}
	if (code === AUTHENTICATION_RATE_LIMITED_CODE) {
		return {
			message:
				"The 'API Token' was refused too many times from this address, so the API stopped answering it for now",
			step: `Check that the 'API Token' of the SourceToDocs credential is correct and has not been revoked, then run the node again. Waiting does not help while the token is wrong, so the node does not retry. See ${codeLink(code)}`,
		};
	}
	return undefined;
}

/** The next step for an answer the node has no special words for: the code's reference, or what to check for the status. */
function nextStep(statusCode: number, code: string | undefined, hasFields: boolean): string {
	if (code !== undefined) {
		return `See ${codeLink(code)} for what this code means and how to fix it`;
	}
	if (statusCode === 401) {
		return "Check that the 'API Token' of the SourceToDocs credential is correct and has not been revoked";
	}
	if (statusCode === 404) {
		return "Check that the ID exists in the workspace the 'API Token' belongs to";
	}
	if (statusCode === 429) {
		return 'Wait a minute, then run the node again';
	}
	if (hasFields) {
		return 'Correct the fields listed above, then run the node again';
	}
	return `Try again shortly. If the answer stays the same, see ${RUN_ERROR_CODES_URL} for the codes the API uses`;
}

/**
 * `errors.code`, `category` and any field errors, then the next step, as one block of text for
 * the error's details.
 *
 * Each part loses its trailing full stop before the parts are joined with one, so a field
 * message that ends a sentence does not produce "..".
 */
function describeFailure(
	envelope: ApiEnvelope,
	statusCode: number,
	known?: KnownRefusal & { serverMessage: string | undefined },
): string {
	const parts: string[] = [];
	const code = errorCodeFromErrors(envelope.errors);
	if (code !== undefined) {
		parts.push(`Code: ${boundText(code)}`);
	}
	if (typeof envelope.category === 'string' && envelope.category !== '') {
		parts.push(`Category: ${boundText(envelope.category)}`);
	}
	const { fields, total } = fieldErrors(envelope.errors);
	for (const [field, messages] of fields) {
		parts.push(`${field}: ${messages}`);
	}
	if (total > fields.length) {
		parts.push(`and ${total - fields.length} more fields`);
	}
	if (known?.serverMessage !== undefined) {
		parts.push(`The API said: ${known.serverMessage}`);
	}
	if (statusCode === 429 && known === undefined) {
		parts.push("The Public API allows 60 requests a minute per 'API Token'");
	}
	parts.push(known?.step ?? nextStep(statusCode, code, fields.length > 0));
	return parts.map((part) => stripTrailingDots(part)).join('. ');
}

/**
 * The business error code the API put under `errors.code`, when there is one.
 *
 * Exported so a `continueOnFail` item can read the same code out of a caught `NodeApiError`'s
 * own `errorResponse.errors` without duplicating this parsing.
 */
export function errorCodeFromErrors(errors: unknown): string | undefined {
	if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) {
		return undefined;
	}
	const code = (errors as Record<string, unknown>).code;
	if (typeof code === 'string') {
		return boundText(code);
	}
	if (Array.isArray(code) && typeof code[0] === 'string') {
		return boundText(code[0]);
	}
	return undefined;
}

/**
 * Entries of `errors` other than `code`, as `[field, 'message; message']` pairs. The first
 * {@link MAX_LISTED_ENTRIES} fields and the first {@link MAX_LISTED_ENTRIES} messages of each are
 * read, every string cut to a bound, so the cost does not grow with what the server echoes;
 * `total` counts every field, so the caller can say how many it left out.
 */
function fieldErrors(errors: unknown): { fields: Array<[string, string]>; total: number } {
	if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) {
		return { fields: [], total: 0 };
	}
	const fields: Array<[string, string]> = [];
	let total = 0;
	for (const field of Object.keys(errors)) {
		if (field === 'code') continue;
		total++;
		if (fields.length >= MAX_LISTED_ENTRIES) continue;
		const messages = (errors as Record<string, unknown>)[field];
		const list = Array.isArray(messages) ? messages : [messages];
		const shown = list.slice(0, MAX_LISTED_ENTRIES).map((message) => boundText(message));
		if (list.length > MAX_LISTED_ENTRIES) {
			shown.push(`and ${list.length - MAX_LISTED_ENTRIES} more`);
		}
		fields.push([boundText(field), shown.join('; ')]);
	}
	return { fields, total };
}
