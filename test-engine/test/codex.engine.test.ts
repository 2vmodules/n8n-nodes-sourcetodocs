/**
 * The codex file as n8n's own package loader reads it: the search aliases reach the node's entry in
 * the nodes panel. Reads the built `dist/`, so run `npm run build` first (CI does).
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals -- a test reads the repo's files; it is not shipped */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { core } from './harness';

const root = join(__dirname, '..', '..');

describe('the codex n8n loads', () => {
	it('carries the aliases and the categories of the node', async () => {
		expect(existsSync(join(root, 'dist/nodes/SourceToDocs/SourceToDocs.node.js')), 'run npm run build first').toBe(true);
		const loader = new core.PackageDirectoryLoader(root);

		await loader.loadAll();

		const entry = (loader.types.nodes as Array<{ name: string; codex?: unknown }>).find((node) => node.name === 'sourceToDocs');
		const codex = entry?.codex as { alias?: string[]; categories?: string[] } | undefined;
		expect(codex?.categories).toEqual(['Productivity', 'Sales']);
		expect(codex?.alias).toEqual(
			expect.arrayContaining(['Invoice', 'Report', 'PDF', 'Google Slides', 'Google Docs', 'Presentation', 'Document generation', 'Template', 'Mail merge']),
		);
	});
});
