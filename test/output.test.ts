import { describe, expect, it } from 'vitest';

import { documentFields } from '../nodes/SourceToDocs/descriptions/DocumentDescription';
import { projectFields } from '../nodes/SourceToDocs/descriptions/ProjectDescription';
import { runFields } from '../nodes/SourceToDocs/descriptions/RunDescription';
import { applyOutput, SELECTABLE_FIELDS } from '../nodes/SourceToDocs/output';
import { flattenRun, folderUrlOf } from '../nodes/SourceToDocs/runs';
import type { RunData } from '../nodes/SourceToDocs/types';

const run = {
	id: 'r', document_id: 'd', workspace_id: 'w', kind: 'single', split_key: null, idempotency_key: 'k', status: 'succeeded',
	file_count: null, progress: null, error_code: null, error_message: null, created_at: 'x', updated_at: 'x', distributions: [],
} as RunData;

describe('folderUrlOf', () => {
	it('is the first destination with a link, skipping null and empty ones', () => {
		const base = { distribution_type: 'google_drive' as const, external_id: 'e' };
		expect(folderUrlOf([{ ...base, url: null }, { ...base, url: '' }, { ...base, url: 'https://f/1' }, { ...base, url: 'https://f/2' }])).toBe('https://f/1');
	});

	it('is null for none, or when the API sent no destinations', () => {
		expect(folderUrlOf([])).toBeNull();
		expect(folderUrlOf(undefined)).toBeNull();
	});
});

describe('flattenRun extended', () => {
	it('adds nothing when not extended, and the six fields when extended', () => {
		expect(Object.keys(flattenRun(run))).not.toContain('warnings');
		expect(Object.keys(flattenRun(run, true))).toEqual(expect.arrayContaining(['warnings', 'generation_stats', 'folder_url', 'document_id', 'processing_started_at', 'finished_at']));
	});
});

describe('applyOutput', () => {
	const item = { run_id: 'r', status: 's', run: { id: 'r' } };

	it('Simplified drops run, Raw keeps it', () => {
		expect(applyOutput([item], { extended: true, mode: 'simplified', fields: [] })).toEqual([{ run_id: 'r', status: 's' }]);
		expect(applyOutput([item], { extended: true, mode: 'raw', fields: [] })).toEqual([item]);
	});

	it('Selected keeps the picked keys in the picked order, and skips one the item lacks', () => {
		const [kept] = applyOutput([item], { extended: true, mode: 'selected', fields: ['status', 'batch_run_id', 'run_id'] });
		expect(Object.keys(kept)).toEqual(['status', 'run_id']);
	});

	it('offers every field a flattened run has', () => {
		const keys = Object.keys(flattenRun(run, true));
		for (const key of keys) expect(SELECTABLE_FIELDS).toContain(key);
	});
});

describe('version gating in the description', () => {
	const gate = (property: { displayOptions?: { show?: Record<string, unknown> } } | undefined) => property?.displayOptions?.show?.['@version'];

	it('Simplify shows only below 1.1, on both operations', () => {
		const simplifies = [...documentFields, ...runFields].filter((f) => f.name === 'simplify');
		expect(simplifies).toHaveLength(2);
		for (const f of simplifies) expect(gate(f)).toEqual([{ _cnd: { lt: 1.1 } }]);
	});

	it('Output, Fields, Return All and Limit show only from 1.1', () => {
		const all = [...documentFields, ...runFields, ...projectFields];
		for (const name of ['output', 'outputFields', 'returnAll', 'limit']) {
			const found = all.filter((f) => f.name === name);
			expect(found.length).toBeGreaterThan(0);
			for (const f of found) expect(gate(f)).toEqual([{ _cnd: { gte: 1.1 } }]);
		}
	});

	it('Return All defaults on and Output defaults to Simplified', () => {
		expect(projectFields.find((f) => f.name === 'returnAll')?.default).toBe(true);
		expect(runFields.find((f) => f.name === 'output')?.default).toBe('simplified');
	});
});
