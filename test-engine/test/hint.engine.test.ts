/**
 * The hint that tells a person Generate starts one run for all input items. Nothing installed
 * evaluates a hint's `displayCondition` (only the n8n editor does), so these cases evaluate it
 * through n8n-workflow's own expression engine, with `$parameter` read from the node and
 * `$input` holding the items that reach it. An expression that cannot be evaluated (no input at
 * all) counts as not shown, which is how the editor treats it.
 */
import { describe, expect, it } from 'vitest';
import type { INodeExecutionData, INodeParameters } from 'n8n-workflow';

import { s2d, s2dDescription, s2dJson, s2dMapped, wf } from './harness';

const hint = s2dDescription.hints?.[0];

function shown(parameters: INodeParameters, itemCount: number): boolean {
	const node = { ...s2d(parameters), id: 'node-0', typeVersion: 1.1, position: [0, 0] as [number, number] };
	const workflow = new wf.Workflow({
		id: 'hint',
		name: 'hint',
		nodes: [node as never],
		connections: {},
		nodeTypes: {
			getByName: () => ({ description: s2dDescription }) as never,
			getByNameAndVersion: () => ({ description: s2dDescription }) as never,
			getKnownTypes: () => ({}),
		},
		active: false,
		settings: { executionOrder: 'v1' },
	});
	const items: INodeExecutionData[] = Array.from({ length: itemCount }, (_unused, index) => ({ json: { index } }));
	try {
		return (
			workflow.expression.getParameterValue(
				hint?.displayCondition ?? 'false',
				null,
				0,
				0,
				node.name,
				items,
				'manual',
				{},
			) === true
		);
	} catch {
		return false;
	}
}

const connected = { rowsFrom: 'connected' };
const json = s2dJson([{ dataSetId: 'x', rows: '[]' }]).parameters;
const mapped = s2dMapped({}).parameters;

describe('the one-run-for-all-items hint', () => {
	it('is declared for the output pane, before execution, as information', () => {
		expect(hint).toMatchObject({ type: 'info', location: 'outputPane', whenToDisplay: 'beforeExecution' });
		expect(hint?.message).toBe(
			'This node starts one run for all input items, not one per item. To make one document per item, put a Loop Over Items node before it.',
		);
	});

	it.each([
		['0 items', 0, false],
		['1 item', 1, false],
		['2 items', 2, true],
		['5 items', 5, true],
	])('Connected, %s: shown is %s', (_name, count, expected) => {
		expect(shown(connected, count)).toBe(expected);
	});

	it.each([
		['JSON', json],
		['Map Columns', mapped],
	])('%s rows never show it, whatever the item count', (_name, parameters) => {
		for (const count of [0, 1, 2, 5]) expect(shown(parameters, count)).toBe(false);
	});

	it('another operation or resource never shows it', () => {
		expect(shown({ operation: 'get', documentId: { __rl: true, mode: 'id', value: 'x' } }, 2)).toBe(false);
		expect(shown({ resource: 'run', operation: 'get', runId: 'r' }, 2)).toBe(false);
	});
});
