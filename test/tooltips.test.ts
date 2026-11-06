import { describe, expect, it } from 'vitest';
import type { INodeProperties } from 'n8n-workflow';

import { SourceToDocs } from '../nodes/SourceToDocs/SourceToDocs.node';

/** One piece of UI text, with where it sits. */
interface Text {
	where: string;
	kind: 'description' | 'hint' | 'operation';
	raw: string;
}

const visible = (raw: string): string => raw.replace(/<[^>]*>/g, '').trim();
/** Sentences end at . ! or ? followed by a space; a dot inside an expression (`.map(`) never does. */
const sentencesOf = (raw: string): number => visible(raw).split(/(?<=[.!?])\s+(?=\S)/).length;

/** Every description and hint of every property, collection item, fixedCollection value and option. */
function collectTexts(properties: INodeProperties[], trail = ''): Text[] {
	const texts: Text[] = [];
	for (const property of properties) {
		const where = `${trail}${property.name}`;
		if (typeof property.description === 'string') {
			texts.push({ where: `${where}.description`, kind: 'description', raw: property.description });
		}
		if (typeof property.hint === 'string') {
			texts.push({ where: `${where}.hint`, kind: 'hint', raw: property.hint });
		}
		for (const option of (property.options ?? []) as unknown as Array<Record<string, unknown>>) {
			if (typeof option.type === 'string') {
				texts.push(...collectTexts([option as unknown as INodeProperties], `${where}/`));
			} else if (Array.isArray(option.values)) {
				texts.push(...collectTexts(option.values as INodeProperties[], `${where}/${String(option.name)}/`));
			} else if (typeof option.description === 'string') {
				texts.push({
					where: `${where}#${String(option.name)}.description`,
					kind: property.name === 'operation' ? 'operation' : 'description',
					raw: option.description,
				});
			}
		}
	}
	return texts;
}

const node = new SourceToDocs().description;
const texts = collectTexts(node.properties);
const checked = texts.filter((text) => text.kind !== 'operation');

describe('the walk reaches every kind of text', () => {
	it('finds collection items, fixedCollection values, option descriptions and operation descriptions', () => {
		const places = texts.map((text) => text.where);
		expect(places).toContain('options/maxWait.description');
		expect(places).toContain('options/additionalDataSets/values/rows.description');
		expect(places).toContain('dataSets/values/rows.hint');
		expect(places.some((place) => place.startsWith('rowsFrom#'))).toBe(true);
		expect(places.some((place) => place.startsWith('output#'))).toBe(true);
		expect(texts.filter((text) => text.kind === 'operation').length).toBeGreaterThanOrEqual(5);
		expect(texts.length).toBeGreaterThan(50);
	});
});

describe('tooltips are short', () => {
	it.each(checked.map((text) => [text.where, text] as const))('%s is at most 250 visible characters and two sentences', (_where, text) => {
		expect(visible(text.raw).length).toBeLessThanOrEqual(250);
		expect(sentencesOf(text.raw)).toBeLessThanOrEqual(2);
	});

	it.each(texts.filter((text) => text.kind === 'operation').map((text) => [text.where, text] as const))(
		'operation %s is at most two sentences',
		(_where, text) => {
			expect(sentencesOf(text.raw)).toBeLessThanOrEqual(2);
		},
	);
});

describe('tooltip style', () => {
	it.each(texts.map((text) => [text.where, text] as const))('%s: a final period only after more than one sentence', (_where, text) => {
		const endsWithPeriod = visible(text.raw).endsWith('.');
		expect(endsWithPeriod).toBe(sentencesOf(text.raw) > 1);
	});

	it.each(texts.map((text) => [text.where, text] as const))('%s has no API jargon or node version numbers', (_where, text) => {
		expect(visible(text.raw)).not.toMatch(/distribution_ids|Public API|\bnode version\b|\bversion 1(\.1)?\b/i);
	});
});

describe('display names and placeholders', () => {
	const names: string[] = [];
	const collectNames = (properties: INodeProperties[]): void => {
		for (const property of properties) {
			names.push(property.displayName);
			for (const option of (property.options ?? []) as unknown as Array<Record<string, unknown>>) {
				if (typeof option.type === 'string') collectNames([option as unknown as INodeProperties]);
				else if (Array.isArray(option.values)) collectNames(option.values as INodeProperties[]);
			}
		}
	};
	collectNames(node.properties);

	it('use a lowercase small word where n8n does', () => {
		expect(names).toContain('Wait for Completion');
		expect(names).toContain('Deliver to Names or IDs');
		expect(names).not.toContain('Wait For Completion');
		expect(names).not.toContain('Deliver To Names or IDs');
	});

	it('Add option is in sentence case', () => {
		const placeholders: string[] = [];
		const visit = (properties: INodeProperties[]): void => {
			for (const property of properties) {
				if (property.type === 'collection' && typeof property.placeholder === 'string') placeholders.push(property.placeholder);
			}
		};
		visit(node.properties);
		expect(placeholders).toEqual(['Add option', 'Add option']);
	});
});
