/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals -- a test reads the repo's README; it is not shipped */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { documentFields, documentOperations } from '../nodes/SourceToDocs/descriptions/DocumentDescription';
import { projectFields } from '../nodes/SourceToDocs/descriptions/ProjectDescription';
import { runFields, runOperations } from '../nodes/SourceToDocs/descriptions/RunDescription';

const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

type Item = { name: string; displayName: string; type: string; default?: unknown; typeOptions?: Record<string, unknown>; displayOptions?: { show?: Record<string, unknown>; hide?: Record<string, unknown> }; description?: string; hint?: string };

/** The Options collection of an operation, and the items inside it. */
const optionsOf = (fields: Array<{ name: string; displayOptions?: { show?: Record<string, unknown> } }>, resource: string, operation: string) =>
	fields.find((f) => f.name === 'options' && JSON.stringify(f.displayOptions?.show) === JSON.stringify({ resource: [resource], operation: [operation] })) as
		| ({ options: Item[]; type: string; default: unknown; displayName: string; placeholder?: string; displayOptions?: unknown } & { name: string })
		| undefined;
const generateOptions = () => optionsOf(documentFields, 'document', 'generate');
const getOptions = () => optionsOf(runFields, 'run', 'get');
const documentGetOptions = () => optionsOf(documentFields, 'document', 'get');
const generateItem = (name: string) => generateOptions()?.options.find((item) => item.name === name);
const getItem = (name: string) => getOptions()?.options.find((item) => item.name === name);

describe('the Options collections', () => {
	it('Generate, Document → Get and Run → Get each have one, shown for their operation, the last property of it', () => {
		for (const [fields, collection, last] of [
			[documentFields, generateOptions(), 'generate'],
			[documentFields, documentGetOptions(), 'get'],
			[runFields, getOptions(), 'get'],
		] as const) {
			expect(collection).toBeDefined();
			expect(collection).toMatchObject({ displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add option', default: {} });
			const ofOperation = fields.filter((f) => JSON.stringify(f.displayOptions?.show ?? {}).includes(`"operation":["${last}"`));
			expect(ofOperation.filter((f) => f.name === 'options')).toHaveLength(1);
			expect(ofOperation.length).toBeGreaterThan(2);
			expect(ofOperation[ofOperation.length - 1]).toBe(collection);
		}
	});

	it('hold the optional fields, in n8n\'s alphabetical order by display name, with their defaults and type options', () => {
		const generate = generateOptions()?.options ?? [];
		expect(generate.map((item) => item.displayName)).toEqual(['Additional Data Sets', 'Deliver to Names or IDs', 'Idempotency Key', 'Max Wait (Seconds)', 'Poll Every (Seconds)', 'Project Name or ID', 'Unknown Fields', 'Wait for Completion']);
		expect(generate.map((item) => item.name)).toEqual(['additionalDataSets', 'distributionIds', 'idempotencyKey', 'maxWait', 'pollEvery', 'projectId', 'unknownKeys', 'waitForCompletion']);
		expect(generate.map((item) => item.default)).toEqual([{}, [], '', 300, 5, '', 'drop', true]);
		expect(generateItem('distributionIds')?.typeOptions).toEqual({ loadOptionsMethod: 'getDistributions', loadOptionsDependsOn: ['documentId.value'] });
		expect(generateItem('maxWait')?.typeOptions).toEqual({ minValue: 1 });
		expect(generateItem('pollEvery')?.typeOptions).toEqual({ minValue: 2 });

		const project = generateItem('projectId');
		expect(project).toMatchObject({ type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getProjects' } });
		expect(project?.description).toMatch(/Choose from the list, or specify an ID using an <a href="https:\/\/docs\.n8n\.io\/code\/expressions\/">expression<\/a>\.$/);
		expect(project?.description).toContain('never sent');
		expect((documentGetOptions()?.options ?? []).map((item) => item.name)).toEqual(['projectId']);
		expect(optionsOf(documentFields, 'document', 'get')?.options[0]).toBe(project);

		const get = getOptions()?.options ?? [];
		expect(get.map((item) => item.displayName)).toEqual(['Max Wait (Seconds)', 'Summary Only']);
		expect(get.map((item) => item.default)).toEqual([300, false]);
	});

	it('their items carry no resource or operation condition, which would hide them for ever inside a collection', () => {
		for (const item of [...(generateOptions()?.options ?? []), ...(getOptions()?.options ?? [])]) {
			const conditions = JSON.stringify(item.displayOptions ?? {});
			expect(conditions, item.name).not.toMatch(/resource|operation/);
		}
	});

	it('Max Wait and Poll Every hide when Wait for Completion is off, not show only when it is on', () => {
		for (const name of ['maxWait', 'pollEvery']) {
			expect(generateItem(name)?.displayOptions, name).toEqual({ hide: { waitForCompletion: [false] } });
		}
	});

	it("Run → Get's Max Wait is for 1.1 and later, and hides for Summary Only", () => {
		expect(getItem('maxWait')?.displayOptions).toEqual({
			show: { '@version': [{ _cnd: { gte: 1.1 } }] },
			hide: { summaryOnly: [true] },
		});
		expect(getItem('summaryOnly')?.displayOptions).toBeUndefined();
	});

	it('none of the names inside an Options collection is a top-level property of Generate or Run → Get', () => {
		// Project is the exception by design: Document → Get Many keeps its own required, top-level one.
		const names = [...(generateOptions()?.options ?? []), ...(getOptions()?.options ?? [])].map((item) => item.name).filter((name) => name !== 'projectId');
		expect(names.length).toBeGreaterThan(8);
		for (const name of names) {
			expect([...documentFields, ...runFields].filter((f) => f.name === name), name).toEqual([]);
		}
		const topLevelProject = documentFields.filter((f) => f.name === 'projectId');
		expect(topLevelProject).toHaveLength(1);
		expect(topLevelProject[0].displayOptions?.show).toEqual({ resource: ['document'], operation: ['getMany'] });
	});

	it('Unknown Fields reads the node\'s Rows Come From (JSON and Map Columns), Additional Data Sets only the Map Columns one', () => {
		expect(generateItem('unknownKeys')?.displayOptions).toEqual({ show: { '/rowsFrom': ['workflow', 'mapped'] } });
		expect(generateItem('additionalDataSets')?.displayOptions).toEqual({ show: { '/rowsFrom': ['mapped'] } });
	});
});

describe('the Document locator', () => {
	it('reloads its list when Options → Project changes', () => {
		const locator = documentFields.find((f) => f.name === 'documentId');
		expect(locator?.typeOptions).toEqual({ loadOptionsDependsOn: ['options.projectId'] });
	});
});

describe('documentFields — Deliver to description', () => {
	it('tells the truth about an empty selection: all enabled distributions, not nowhere', () => {
		const field = generateItem('distributionIds');

		expect(field).toBeDefined();
		expect(field?.description).toContain('all enabled distributions');
		expect(field?.description).not.toContain('deliver nowhere');
	});

	it('keeps API jargon out of the tooltip: the request field it becomes is explained in the README', () => {
		const field = generateItem('distributionIds');

		expect(field?.description).not.toContain('distribution_ids');
		expect(field?.hint).toBeUndefined();
		expect(readme).toContain('`distribution_ids`');
		expect(readme).toMatch(/split Document ignores it and delivers through its own distributions/);
	});
});

describe('documentFields — Unknown Fields', () => {
	it('defaults to Drop', () => {
		const field = generateItem('unknownKeys');

		expect(field).toBeDefined();
		expect(field?.default).toBe('drop');
	});

	it('offers exactly Drop and Refuse', () => {
		const field = generateItem('unknownKeys');
		const values = ((field as { options?: Array<{ value: string }> } | undefined)?.options ?? []).map((option) => option.value);

		expect(values).toEqual(['drop', 'refuse']);
	});

	it('is one item of Options, with one description and no hint', () => {
		expect(documentFields.filter((f) => f.name === 'unknownKeys')).toEqual([]);
		const field = generateItem('unknownKeys');

		expect(field?.hint).toBeUndefined();
		expect((field?.description ?? '').split(/(?<=\.)\s/)).toHaveLength(2);
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
		const fields = (generateOptions()?.options ?? []).filter((field) => field.name === 'unknownKeys');

		expect(fields.map((field) => field.displayName)).toEqual(['Unknown Fields']);
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

		expect(hints.length).toBeGreaterThan(2);
		for (const hint of hints) {
			expect(hint[0], hint).toBe(hint[0].toUpperCase());
		}
	});

	it('the README says the real bounds of Max Wait and Poll Every, which the tooltips no longer repeat', () => {
		expect(readme).toContain('**Max Wait** defaults to 300 s, is never under **Poll Every**');
		expect(readme).toContain('never over 3600 s');
		expect(readme).toContain('**Poll Every** defaults to 5 s, is never under 2 s');
		for (const name of ['maxWait', 'pollEvery']) {
			expect(generateItem(name)?.description, name).not.toContain('3600');
		}
	});

	it("Run → Get's Max Wait keeps Generate's name, default and bounds; the README says the bounds", () => {
		const generate = generateItem('maxWait');
		const get = getItem('maxWait');

		expect(get?.displayName).toBe(generate?.displayName);
		expect(get?.default).toBe(generate?.default);
		expect(get?.typeOptions).toEqual(generate?.typeOptions);
		expect(get?.description).not.toMatch(/version/i);
		expect(readme).toContain("the same bounds as Generate's, never under 5 s");
		expect(readme).toContain('at most `3600`');
	});

	it('the Idempotency Key tooltip is short, and the README holds the rules it no longer repeats', () => {
		const description = generateItem('idempotencyKey')?.description ?? '';

		expect(description).not.toMatch(/^Optional/);
		expect(description).not.toContain(':after:');
		expect(readme).toContain("A run that ended `failed` is not adopted, whether or not it made its document");
		expect(readme).toContain('`:after:`');
		expect(readme).toContain('6 hours');
		expect(readme).toContain('`idempotent_replay: true`');
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
			/(?<!')\bWait for Completion\b(?!')/,
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
