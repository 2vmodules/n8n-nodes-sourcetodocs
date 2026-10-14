import { describe, expect, it } from 'vitest';

import { documentFields, documentOperations } from '../nodes/SourceToDocs/descriptions/DocumentDescription';
import { projectFields } from '../nodes/SourceToDocs/descriptions/ProjectDescription';
import { runFields, runOperations } from '../nodes/SourceToDocs/descriptions/RunDescription';

describe('documentFields — Deliver To description', () => {
	it('tells the truth about an empty selection: all enabled distributions, not nowhere', () => {
		const field = documentFields.find((f) => f.name === 'distributionIds');

		expect(field).toBeDefined();
		expect(field?.description).toContain('all enabled distributions');
		expect(field?.description).not.toContain('deliver nowhere');
	});

	it('keeps inline_data/distribution_ids jargon out of the description, in the hint instead', () => {
		const field = documentFields.find((f) => f.name === 'distributionIds');

		expect(field?.description).not.toContain('distribution_ids');
		expect(field?.hint).toContain('distribution_ids');
	});
});

describe('documentFields — Unknown Fields', () => {
	it('defaults to Drop', () => {
		const field = documentFields.find((f) => f.name === 'unknownKeys');

		expect(field).toBeDefined();
		expect(field?.default).toBe('drop');
	});

	it('offers exactly Drop and Refuse', () => {
		const field = documentFields.find((f) => f.name === 'unknownKeys');
		const values = (field?.options as Array<{ value: string }>).map((option) => option.value);

		expect(values).toEqual(['drop', 'refuse']);
	});

	it('only shows for rows from this workflow', () => {
		const field = documentFields.find((f) => f.name === 'unknownKeys');

		expect(field?.displayOptions?.show?.rowsFrom).toEqual(['workflow']);
	});
});

describe('documentFields — Simplify', () => {
	it('defaults to on', () => {
		const field = documentFields.find((f) => f.name === 'simplify');

		expect(field).toBeDefined();
		expect(field?.default).toBe(true);
	});
});

describe('documentFields — Rows description avoids API jargon', () => {
	it('does not say "keyed by"', () => {
		const dataSets = documentFields.find((f) => f.name === 'dataSets');
		const dataSetOption = dataSets?.options?.[0] as { values?: Array<{ name: string; description?: string }> };
		const rows = dataSetOption.values?.find((value) => value.name === 'rows');

		expect(rows?.description).not.toContain('keyed by');
	});
});

describe('action strings drop articles', () => {
	const actions = [
		...documentOperations.flatMap((property) => property.options ?? []),
		...runOperations.flatMap((property) => property.options ?? []),
	]
		.map((option) => (option as { action?: string }).action)
		.filter((action): action is string => typeof action === 'string');

	it('has at least one action to check', () => {
		expect(actions.length).toBeGreaterThan(0);
	});

	it.each(actions)('%s has no leading article on its object', (action) => {
		expect(action).not.toMatch(/\b(a|an|the)\b/i);
	});
});

describe('copy per n8n\'s UX guidelines', () => {
	const all = [...documentFields, ...runFields, ...projectFields];

	it('labels Unknown Fields, and keeps the parameter name saved workflows hold', () => {
		const fields = documentFields.filter((field) => field.name === 'unknownKeys');

		expect(fields).toHaveLength(2);
		expect(fields.map((field) => field.displayName)).toEqual(['Unknown Fields', 'Unknown Fields']);
		expect(all.some((field) => field.displayName === 'Unknown Keys')).toBe(false);
	});

	it('every hint starts in sentence case', () => {
		const hints: string[] = [];
		const collect = (fields: unknown[]): void => {
			for (const field of fields as Array<{ hint?: string; options?: unknown[]; values?: unknown[] }>) {
				if (typeof field.hint === 'string') hints.push(field.hint);
				collect(field.options ?? []);
				collect(field.values ?? []);
			}
		};
		collect(all);

		expect(hints.length).toBeGreaterThan(4);
		for (const hint of hints) {
			expect(hint[0], hint).toBe(hint[0].toUpperCase());
		}
	});

	it('Max Wait and Poll Every say their cap and how they relate', () => {
		for (const name of ['maxWait', 'pollEvery']) {
			const description = documentFields.find((field) => field.name === name)?.description ?? '';

			expect(description, name).toContain('3600 s');
			expect(description, name).toContain("'Max Wait (Seconds)' is at least 'Poll Every (Seconds)'");
		}
	});

	it("Run → Get's Max Wait says its bounds, which are Generate's", () => {
		const generate = documentFields.find((field) => field.name === 'maxWait');
		const get = runFields.find((field) => field.name === 'maxWait');

		expect(get?.displayName).toBe(generate?.displayName);
		expect(get?.default).toBe(generate?.default);
		expect(get?.typeOptions).toEqual(generate?.typeOptions);
		expect(get?.displayOptions?.show).toMatchObject({ resource: ['run'], operation: ['get'] });
		expect(get?.description).toContain('3600 s');
		expect(get?.description).toContain("at least 5 s, the 'Poll Every (Seconds)' default");
	});

	it('the Idempotency Key description matches the code: any run that ended failed starts a new one', () => {
		const description = documentFields.find((field) => field.name === 'idempotencyKey')?.description ?? '';

		expect(description).toContain("A run that ended with status 'failed' is not resumed, whether or not it made its document");
		expect(description).not.toContain('ended without producing a document');
	});

	it('descriptions put the names of parameters, fields and values in single quotes', () => {
		const collect = (value: unknown): string[] =>
			Array.isArray(value)
				? value.flatMap(collect)
				: typeof value === 'object' && value !== null
					? Object.entries(value).flatMap(([key, inner]) =>
							(key === 'description' || key === 'hint') && typeof inner === 'string' ? [inner] : collect(inner),
						)
					: [];
		const text = collect([...documentFields, ...runFields]).join('\n');
		const bare = [
			/(?<!')\bUnknown Fields\b(?!')/,
			/(?<!')\bMax Wait\b(?! \(Seconds\))(?!')/,
			/(?<!')\bPoll Every\b(?! \(Seconds\))(?!')/,
			/(?<!')\bWait For Completion\b(?!')/,
			/(?<!')\bSummary Only\b(?!')/,
			/(?<!')\bRetry On Fail\b(?!')/,
			/(?<!')\b(?:idempotent_replay|timed_out)\b(?!')/,
		];
		for (const pattern of bare) {
			expect(text, String(pattern)).not.toMatch(pattern);
		}
	});

	it('the version 1 Simplify description is the one n8n prescribes', () => {
		const simplify = [...documentFields, ...runFields].filter((field) => field.name === 'simplify');

		expect(simplify).toHaveLength(2);
		for (const field of simplify) {
			expect(field.description).toBe('Whether to return a simplified version of the response instead of the raw data');
		}
	});
});
