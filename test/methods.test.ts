import { describe, expect, it } from 'vitest';

import { DOCUMENT_URL_REGEX } from '../nodes/SourceToDocs/descriptions/shared';

// The load-options, list-search and resource-mapping methods run on the engine:
// test-engine/test/methods.engine.test.ts.

describe('the document URL regex (resourceLocator extractValue)', () => {
	const regex = new RegExp(DOCUMENT_URL_REGEX);

	it("extracts the id from the app's document URL", () => {
		const match = regex.exec(
			'https://app.sourcetodocs.com/documents/show/9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6',
		);

		expect(match?.[1]).toBe('9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6');
	});

	it('does not match a URL with no /documents/show/<uuid> path', () => {
		expect(regex.exec('https://app.sourcetodocs.com/projects/9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6')).toBeNull();
		expect(regex.exec('https://app.sourcetodocs.com/documents/show/not-a-uuid')).toBeNull();
	});

	// Anchored to a real UUID shape, case-insensitive — not 36 arbitrary hex-or-dash characters.
	it('extracts an upper-case UUID too', () => {
		const match = regex.exec(
			'https://app.sourcetodocs.com/documents/show/9F1C2A4E-3B77-4A51-9E2D-7C1F0B8AD4E6',
		);

		expect(match?.[1]).toBe('9F1C2A4E-3B77-4A51-9E2D-7C1F0B8AD4E6');
	});

	it('does not match 36 dashes, which the old character-class pattern accepted', () => {
		const thirtySixDashes = '-'.repeat(36);
		expect(thirtySixDashes).toHaveLength(36);

		expect(regex.exec(`https://app.sourcetodocs.com/documents/show/${thirtySixDashes}`)).toBeNull();
	});

	it('matches regardless of host — only the id capture is used', () => {
		const match = regex.exec('https://evil.example/documents/show/9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6');

		expect(match?.[1]).toBe('9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6');
	});
});
