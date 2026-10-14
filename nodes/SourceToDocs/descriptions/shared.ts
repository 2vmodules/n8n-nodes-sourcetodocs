/** A UUID's own shape, case-insensitive, with no anchors — embedded by both regexes below. */
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * The document URL's id capture, as the app renders it: `/documents/show/<uuid>`, case-
 * insensitive. Anchored to the literal path segment and a real UUID shape — not 36 arbitrary
 * hex-or-dash characters — so a foreign host still matches (harmless: only the id is used) but
 * 36 dashes or a non-UUID string does not.
 */
export const DOCUMENT_URL_REGEX = `/documents/show/(${UUID_PATTERN})`;

/**
 * What By URL's *validation* accepts. n8n tests it as `^<regex>$` against the whole value (n8n-workflow
 * `node-helpers.js`), so unlike {@link DOCUMENT_URL_REGEX} (which extracts the id, unanchored) it must
 * describe the whole URL: an https origin, `/documents/show/<uuid>`, then optionally `/`, `?...` or `#...`.
 */
export const DOCUMENT_URL_VALIDATION_REGEX = `https://[^/\\s?#@]+/documents/show/${UUID_PATTERN}/?(\\?[^#\\s]*)?(#\\S*)?`;

/** A UUID, case-insensitive, for the Document resource locator's By ID mode. */
export const UUID_REGEX = `^${UUID_PATTERN}$`;
