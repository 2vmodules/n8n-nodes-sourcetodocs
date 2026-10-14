/**
 * Server text in a message. An API answer can echo what a caller sent, so any
 * string taken from one is cut to a bound before it is processed or shown, and nothing here uses
 * a regular expression: a pattern like `/\.+$/` takes quadratic time on a long run of dots.
 */

/** The longest piece of server text that goes into a message or description. */
export const MAX_SERVER_TEXT = 500;

/** How many entries of a list from the server a message names before it says how many more there were. */
export const MAX_LISTED_ENTRIES = 10;

/** `value` as a string cut to `max` characters, with `…` marking a cut. Cuts before any processing. */
export function boundText(value: unknown, max: number = MAX_SERVER_TEXT): string {
	const text = typeof value === 'string' ? value : String(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `text` without its trailing full stops, in one linear pass. */
export function stripTrailingDots(text: string): string {
	let end = text.length;
	while (end > 0 && text.charCodeAt(end - 1) === 46) {
		end--;
	}
	return end === text.length ? text : text.slice(0, end);
}

/** Where a person reads what a run or API code means and how to fix it. */
export const RUN_ERROR_CODES_URL = 'https://app.sourcetodocs.com/docs/reference/run-error-codes/';

/** The troubleshooting guide, which has one heading for every code the API answers or a run ends with. */
const TROUBLESHOOTING_URL = 'https://app.sourcetodocs.com/docs/guides/troubleshooting/';

/**
 * The troubleshooting guide's entry for `code`: the code lowercased with its dots removed is the
 * heading's anchor (`plan.limit_exceeded.generations` is `#planlimit_exceededgenerations`). Run,
 * delivery, plan and split codes alike have one. A code the server sent is checked before it goes
 * into a link, and one that is not made of letters, digits, dots and underscores gets the
 * run error codes reference instead.
 */
export function codeLink(code: string | null | undefined): string {
	if (typeof code !== 'string' || !/^[A-Za-z0-9_.]{1,100}$/.test(code)) {
		return RUN_ERROR_CODES_URL;
	}
	return `${TROUBLESHOOTING_URL}#${code.toLowerCase().split('.').join('')}`;
}

/** The troubleshooting guide's entries for the two refusals that name a limit. */
export const BODY_TOO_LARGE_URL = codeLink('request_body_too_large');
export const SOURCE_TOO_LARGE_URL = codeLink('source_too_large');

/** The `errors.code` of a 429 that says the 'API Token' was refused too many times from one address. */
export const AUTHENTICATION_RATE_LIMITED_CODE = 'authentication_rate_limited';
