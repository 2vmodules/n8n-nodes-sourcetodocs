/**
 * Every id the node puts in a URL or a request body goes through here first.
 *
 * An id can come from an expression or from `$fromAI`, so it can be anything: `../../projects#`
 * would aim the request (and the token) at another path of the API host. A Public API id is a
 * UUID; anything else is refused before a request is made, and what passes is URL-encoded.
 */
import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/** A Public API id. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUOTED_VALUE_LIMIT = 40;

/** The refused value, quoted and cut so that a long or odd value cannot flood the message. */
function quoteForMessage(value: unknown): string {
	if (typeof value !== 'string') {
		return value === null
			? 'null'
			: value === undefined
				? 'nothing'
				: `a ${Array.isArray(value) ? 'list' : typeof value}`;
	}
	const cut =
		value.length > QUOTED_VALUE_LIMIT ? `${value.slice(0, QUOTED_VALUE_LIMIT)}...` : value;
	return JSON.stringify(cut);
}

/**
 * `value` as a trimmed UUID, or a `NodeOperationError` that names `parameter` (the label the
 * person sees: Document, Run ID, Project, Data Set, Deliver To) and quotes the value.
 */
export function assertId(node: INode, parameter: string, value: unknown): string {
	const trimmed = typeof value === 'string' ? value.trim() : value;
	if (typeof trimmed !== 'string' || !UUID_PATTERN.test(trimmed)) {
		throw new NodeOperationError(
			node,
			`'${parameter}' is not a valid ID: ${quoteForMessage(value)}`,
			{
				description: `'${parameter}' must be an ID such as 9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6. Nothing was sent.`,
			},
		);
	}
	return trimmed;
}

/** {@link assertId}, then URL-encoded: the form that goes into a request path. */
export function idForPath(node: INode, parameter: string, value: unknown): string {
	return encodeURIComponent(assertId(node, parameter, value));
}

/** A list of ids (Deliver To), each checked; anything but a list is refused. */
export function assertIds(node: INode, parameter: string, value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new NodeOperationError(
			node,
			`'${parameter}' must be a list of IDs, got ${quoteForMessage(value)}`,
			{
				description: `Give '${parameter}' one ID or several, for example [ "9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6" ]. Nothing was sent.`,
			},
		);
	}
	return value.map((entry) => assertId(node, parameter, entry));
}
