/**
 * Each template under `templates/` is loaded as the file is and run
 * on the real engine in the v1 execution order. Only the third-party nodes (and n8n's own trigger,
 * Form and sticky-note nodes) are swapped for stand-in node types; the SourceToDocs node is the
 * real one, at the `typeVersion` the template pins.
 *
 * Where each stand-in's output shape comes from. n8n's docs describe these nodes' parameters, not
 * their output items, so the shapes follow the service APIs the nodes wrap and the repository's own
 * README, which already states what lands on the items:
 * - Airtable (Search, Return All): one item per record, the record's fields flattened next to `id`
 *   and `createdTime` (Airtable REST "List records", which the node flattens; README "Unknown Fields").
 * - Form Trigger: one item, a key per field label, plus `submittedAt` and `formMode` (README "Unknown
 *   Keys" and the Form template's description).
 * - Schedule Trigger: `timestamp` plus the readable date parts (the node's source, ScheduleTrigger).
 * - Manual Trigger: hands on its start item, an empty one.
 * - Gmail (Send): the Gmail API `users.messages.send` response, `{ id, threadId, labelIds }`.
 * - Slack (Post a message): Slack `chat.postMessage` as the node simplifies it, `ok`, `channel`,
 *   `message_timestamp`, `message`.
 * - n8n Form, Form Ending: passes its input item on.
 * The stand-ins that send record each one's parameters, resolved by n8n's expression engine against
 * the SourceToDocs node's real output, so the template's own expressions are what is asserted.
 */
import { describe, expect, it } from 'vitest';

import {
	API_PATH,
	DOC_ID,
	DS2_ID,
	DS_ID,
	documentPayload,
	failure,
	ok,
	readTemplate,
	runPayload,
	runTemplate,
	standInLog,
	useFakeApis,
	type Router,
} from './harness';

const startApi = useFakeApis();

const RUN_ID = 'c0000000-0000-4000-8000-000000000001';
const finished = (name: string, url: string) => ({
	document_id: 'd-1',
	document_url: url,
	document_name: name,
	page_count: 1,
	source_document_id: 'src-1',
	source_name: 'Template',
});

const documentLocator = { __rl: true, mode: 'id', value: DOC_ID };

const TEMPLATES = ['weekly-report-from-crm-deals.json', 'one-invoice-per-customer.json', 'generate-on-form-submission.json'];

describe('the sticky notes promise only what the flow produces', () => {
	it.each(['weekly-report-from-crm-deals.json', 'generate-on-form-submission.json'])('%s does not promise a message for a run that failed', (file) => {
		const note = JSON.stringify(readTemplate(file));

		expect(note).not.toMatch(/or the run failed/);
		expect(note).toContain('stops the workflow');
	});

	it('the invoice sticky note says a batch of failed files stops the workflow, and never says it cannot fail', () => {
		const note = JSON.stringify(readTemplate('one-invoice-per-customer.json'));

		expect(note).not.toContain('It never fails the run');
		expect(note).toContain('every file failed');
	});
});

describe('every template file', () => {
	it.each(TEMPLATES)(
		'%s runs in the v1 order, carries a setup sticky note and pins the node at 1.1',
		(file) => {
			const template = readTemplate(file);
			expect(template.settings.executionOrder).toBe('v1');
			const notes = template.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
			expect(notes).toHaveLength(1);
			expect(String(notes[0].parameters.content)).toMatch(/credential/i);
			expect(String(notes[0].parameters.content)).toMatch(/Document/);
			expect(String(notes[0].parameters.content)).toMatch(/Data Set/);
			const s2d = template.nodes.find((n) => n.type === '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs');
			expect(s2d?.typeVersion).toBe(1.1);
			expect(s2d?.parameters).toMatchObject({ output: 'simplified' });
			expect(s2d?.parameters).not.toHaveProperty('simplify');
		},
	);
});

describe('no template ships a fixed webhookId', () => {
	it.each(TEMPLATES)('%s has none, so n8n assigns fresh ones on import', (file) => {
		const template = readTemplate(file);

		expect(JSON.stringify(template)).not.toContain('webhookId');
		for (const node of template.nodes) expect(node).not.toHaveProperty('webhookId');
	});
});

describe('weekly-report-from-crm-deals.json', () => {
	it('sends the deals as one Data Set and posts the file link to Slack', async () => {
		const api = await startApi((request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ status: 'succeeded', output_result: finished('Weekly', 'https://docs.google.com/presentation/d/p-1') }) }, 201)
				: request.path === `${API_PATH}/documents/${DOC_ID}`
					? ok(documentPayload.data)
					: failure(404, 'not_found', 'Resource not found.'),
		);

		const result = await runTemplate('weekly-report-from-crm-deals.json', {
			baseUrl: api.baseUrl,
			fixtures: {
				'Every Monday morning': [{ json: { timestamp: '2026-10-12T08:00:00.000+00:00', 'Readable date': 'October 12th 2026, 8:00:00 am', 'Day of week': 'Monday' } }],
				'Get open deals': [
					{ json: { id: 'rec1', createdTime: '2026-09-01T10:00:00.000Z', 'Client name': 'Acme', Amount: 1200 } },
					{ json: { id: 'rec2', createdTime: '2026-09-02T10:00:00.000Z', 'Client name': 'Globex', Amount: 800 } },
				],
			},
			pick: (params) => ({ ...params, documentId: documentLocator, dataSets: { values: [{ dataSetId: DS_ID, rows: (params.dataSets as { values: Array<{ rows: string }> }).values[0].rows }] } }),
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.order).toEqual(['Every Monday morning', 'Get open deals', 'SourceToDocs', 'Post to #sales']);
		const start = api.posts()[0];
		expect(start.body).toMatchObject({
			inline_data: { [DS_ID]: [{ 'Client name': 'Acme', Amount: 1200 }, { 'Client name': 'Globex', Amount: 800 }] },
		});
		expect(api.posts()).toHaveLength(1);
		expect(result.json('SourceToDocs')[0]).toMatchObject({ file_url: 'https://docs.google.com/presentation/d/p-1', dropped_keys: { [DS_ID]: ['id', 'createdTime'] } });
		expect(standInLog).toEqual([
			expect.objectContaining({ node: 'Post to #sales', params: expect.objectContaining({ text: "This week's deals report is ready: https://docs.google.com/presentation/d/p-1" }) }),
		]);
	});
});

describe('weekly-report-from-crm-deals.json, a report that did not finish', () => {
	const deals = [{ json: { id: 'rec1', createdTime: '2026-09-01T10:00:00.000Z', 'Client name': 'Acme', Amount: 1200 } }];
	const pick = (params: Record<string, unknown>) => ({
		...params,
		documentId: documentLocator,
		maxWait: 2,
		pollEvery: 2,
		dataSets: { values: [{ dataSetId: DS_ID, rows: (params.dataSets as { values: Array<{ rows: string }> }).values[0].rows }] },
	});
	const route = (run: ReturnType<typeof runPayload>): Router => (request) =>
		request.method === 'POST'
			? ok({ run }, 201)
			: request.path === `${API_PATH}/runs/${run.id}`
				? ok({ run })
				: request.path === `${API_PATH}/documents/${DOC_ID}`
					? ok(documentPayload.data)
					: failure(404, 'not_found', 'Resource not found.');

	it('says the wait ended when the run is still going, instead of posting an empty link', async () => {
		const api = await startApi(route(runPayload({ status: 'processing' })));

		const result = await runTemplate('weekly-report-from-crm-deals.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'Get open deals': deals },
			pick,
		});

		expect(result.run.status).toBe('success');
		expect(standInLog).toHaveLength(1);
		const text = String(standInLog[0].params.text);
		expect(text).toContain('not ready');
		expect(text).toContain('still being generated');
		expect(text).not.toMatch(/ready: ?$/);
		expect(text).not.toContain('null');
	});

	it('posts the link of a report that finished with warnings (partial_success with a file)', async () => {
		const api = await startApi(route(runPayload({ status: 'partial_success', output_result: finished('Weekly', 'https://docs.google.com/presentation/d/p-2') })));

		const result = await runTemplate('weekly-report-from-crm-deals.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'Get open deals': deals },
			pick,
		});

		expect(result.run.status).toBe('success');
		expect(String(standInLog[0].params.text)).toBe("This week's deals report is ready: https://docs.google.com/presentation/d/p-2");
	});

	it('still says not ready for a partial_success run that has no file', async () => {
		const api = await startApi(route(runPayload({ status: 'partial_success' })));

		const result = await runTemplate('weekly-report-from-crm-deals.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'Get open deals': deals },
			pick,
		});

		expect(result.run.status).toBe('success');
		expect(String(standInLog[0].params.text)).toContain('its status is partial_success');
	});

	it('says so when the run was cancelled, with its status', async () => {
		const api = await startApi(route(runPayload({ status: 'cancelled' })));

		const result = await runTemplate('weekly-report-from-crm-deals.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'Get open deals': deals },
			pick,
		});

		expect(result.run.status).toBe('success');
		const text = String(standInLog[0].params.text);
		expect(text).toContain('not ready');
		expect(text).toContain('its status is cancelled');
	});
});

describe('generate-on-form-submission.json', () => {
	it('sends the form fields as one row and shows the file link on the ending page', async () => {
		const api = await startApi((request) =>
			request.method === 'POST'
				? ok({ run: runPayload({ status: 'succeeded', output_result: finished('Report', 'https://docs.google.com/document/d/f-1') }) }, 201)
				: request.path === `${API_PATH}/documents/${DOC_ID}`
					? ok(documentPayload.data)
					: failure(404, 'not_found', 'Resource not found.'),
		);

		const result = await runTemplate('generate-on-form-submission.json', {
			baseUrl: api.baseUrl,
			fixtures: {
				'On form submission': [{ json: { 'Client name': 'Acme', Amount: 1200, submittedAt: '2026-10-12T09:30:00.000+00:00', formMode: 'production' } }],
			},
			pick: (params) => ({ ...params, documentId: documentLocator, mappedDataSetId: DS_ID }),
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.order).toEqual(['On form submission', 'SourceToDocs', 'Show the link']);
		expect(api.posts()).toHaveLength(1);
		expect(api.posts()[0].body).toMatchObject({ inline_data: { [DS_ID]: [{ 'Client name': 'Acme', Amount: 1200 }] } });
		expect(result.json('SourceToDocs')[0]).toMatchObject({ file_url: 'https://docs.google.com/document/d/f-1', dropped_keys: { [DS_ID]: ['submittedAt', 'formMode'] } });
		expect(standInLog).toEqual([
			expect.objectContaining({ node: 'Show the link', params: expect.objectContaining({ completionTitle: 'Your document is ready', completionMessage: 'https://docs.google.com/document/d/f-1' }) }),
		]);
	});

	it('shows a message, not an empty link, when the wait times out', async () => {
		const run = runPayload({ status: 'processing' });
		const api = await startApi((request) =>
			request.method === 'POST'
				? ok({ run }, 201)
				: request.path === `${API_PATH}/runs/${run.id}`
					? ok({ run })
					: request.path === `${API_PATH}/documents/${DOC_ID}`
						? ok(documentPayload.data)
						: failure(404, 'not_found', 'Resource not found.'),
		);

		const result = await runTemplate('generate-on-form-submission.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'On form submission': [{ json: { 'Client name': 'Acme', Amount: 1200 } }] },
			pick: (params) => ({ ...params, documentId: documentLocator, mappedDataSetId: DS_ID, maxWait: 2, pollEvery: 2 }),
		});

		expect(result.run.status).toBe('success');
		expect(standInLog).toHaveLength(1);
		const message = String(standInLog[0].params.completionMessage);
		expect(message).toContain('still being generated');
		expect(standInLog[0].params.completionTitle).toBe('Your document is not ready yet');
		expect(message).not.toBe('');
		expect(message).not.toContain('null');
	});

	it('shows the link of a run that finished with warnings (partial_success with a file)', async () => {
		const run = runPayload({ status: 'partial_success', output_result: finished('Report', 'https://docs.google.com/document/d/f-2') });
		const api = await startApi((request) =>
			request.method === 'POST'
				? ok({ run }, 201)
				: request.path === `${API_PATH}/documents/${DOC_ID}`
					? ok(documentPayload.data)
					: failure(404, 'not_found', 'Resource not found.'),
		);

		const result = await runTemplate('generate-on-form-submission.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'On form submission': [{ json: { 'Client name': 'Acme', Amount: 1200 } }] },
			pick: (params) => ({ ...params, documentId: documentLocator, mappedDataSetId: DS_ID }),
		});

		expect(result.run.status).toBe('success');
		expect(standInLog[0].params.completionTitle).toBe('Your document is ready');
		expect(standInLog[0].params.completionMessage).toBe('https://docs.google.com/document/d/f-2');
	});

	it('shows a message when the run ended without a file (cancelled)', async () => {
		const run = runPayload({ status: 'cancelled' });
		const api = await startApi((request) =>
			request.method === 'POST'
				? ok({ run }, 201)
				: request.path === `${API_PATH}/documents/${DOC_ID}`
					? ok(documentPayload.data)
					: failure(404, 'not_found', 'Resource not found.'),
		);

		const result = await runTemplate('generate-on-form-submission.json', {
			baseUrl: api.baseUrl,
			fixtures: { 'On form submission': [{ json: { 'Client name': 'Acme', Amount: 1200 } }] },
			pick: (params) => ({ ...params, documentId: documentLocator, mappedDataSetId: DS_ID }),
		});

		expect(result.run.status).toBe('success');
		expect(String(standInLog[0].params.completionMessage)).toContain('could not be generated (status: cancelled)');
		expect(standInLog[0].params.completionTitle).toBe('Your document is not ready yet');
	});
});

describe('one-invoice-per-customer.json', () => {
	const customers = [
		{ id: 'recC1', createdTime: '2026-09-01T00:00:00.000Z', Name: 'Acme', Email: 'ap@acme.test' },
		{ id: 'recC2', createdTime: '2026-09-01T00:00:00.000Z', Name: 'Globex', Email: 'ap@globex.test' },
		{ id: 'recC3', createdTime: '2026-09-01T00:00:00.000Z', Name: 'Initech', Email: 'ap@initech.test' },
	];
	const lines = [
		{ id: 'recL1', createdTime: '2026-09-02T00:00:00.000Z', 'Customer Email': 'ap@acme.test', Sku: 'A-1', Qty: 2 },
		{ id: 'recL2', createdTime: '2026-09-02T00:00:00.000Z', 'Customer Email': 'ap@acme.test', Sku: 'A-2', Qty: 1 },
		{ id: 'recL3', createdTime: '2026-09-02T00:00:00.000Z', 'Customer Email': 'ap@globex.test', Sku: 'G-1', Qty: 5 },
		{ id: 'recL4', createdTime: '2026-09-02T00:00:00.000Z', 'Customer Email': 'ap@initech.test', Sku: 'I-1', Qty: 3 },
	];
	const splitDocument = {
		document: {
			...documentPayload.data.document,
			split_enabled: true,
			data_sets: [
				{ ...documentPayload.data.document.data_sets[0], name: 'Customers', columns: ['Name', 'Email'].map((name) => ({ name, type: 'text', selected: true })) },
				{ ...documentPayload.data.document.data_sets[1], name: 'Lines', columns: ['Customer Email', 'Sku', 'Qty'].map((name) => ({ name, type: 'text', selected: true })) },
			],
		},
	};

	it('sends both Data Sets and emails each invoice to its own customer', async () => {
		const children = customers.map((c, i) =>
			runPayload({
				id: `child-${i}`,
				split_key: c.Email,
				status: 'succeeded',
				output_result: finished(`Invoice ${c.Name}`, `https://docs.google.com/document/d/inv-${i}`),
			}),
		);
		const router: Router = (request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: RUN_ID, kind: 'batch', status: 'succeeded', file_count: 3 }) }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}/children`) return ok({ runs: children });
			return failure(404, 'not_found', 'Resource not found.');
		};
		const api = await startApi(router);

		const result = await runTemplate('one-invoice-per-customer.json', {
			baseUrl: api.baseUrl,
			fixtures: {
				'Get customers': customers.map((json) => ({ json })),
				'Get invoice lines': lines.map((json) => ({ json })),
			},
			pick: (params) => {
				const entries = (params.dataSets as { values: Array<{ rows: string }> }).values;
				return {
					...params,
					documentId: documentLocator,
					dataSets: { values: [{ dataSetId: DS_ID, rows: entries[0].rows }, { dataSetId: DS2_ID, rows: entries[1].rows }] },
				};
			},
		});

		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		// The chain the READMEs describe, in this order, with the lines read once for all customers.
		expect(result.order).toEqual([
			'When clicking "Execute workflow"',
			'Get customers',
			'Get invoice lines',
			'SourceToDocs',
			'Has an invoice?',
			'Email the invoice',
		]);
		expect(result.out['Get invoice lines']).toHaveLength(1);
		expect(result.json('Get invoice lines')).toHaveLength(4);

		// Both Data Sets are sent, each with its own rows and without Airtable's id and createdTime.
		expect(api.posts()).toHaveLength(1);
		expect((api.posts()[0].body as { inline_data: unknown }).inline_data).toEqual({
			[DS_ID]: customers.map(({ Name, Email }) => ({ Name, Email })),
			[DS2_ID]: lines.map(({ 'Customer Email': email, Sku, Qty }) => ({ 'Customer Email': email, Sku, Qty })),
		});

		// One output item per customer file, and Gmail is addressed from each file's split_key.
		expect(result.json('SourceToDocs').map((item) => item.split_key)).toEqual(customers.map((c) => c.Email));
		expect(result.json('No invoice, not emailed')).toHaveLength(0);
		expect(standInLog.map((entry) => entry.params.sendTo)).toEqual(customers.map((c) => c.Email));
		expect(standInLog.map((entry) => entry.params.message)).toEqual(
			customers.map((_c, i) => `Your invoice is ready: https://docs.google.com/document/d/inv-${i}`),
		);
		expect(result.json('Email the invoice')).toHaveLength(3);
	});

	const pickBoth = (params: Record<string, unknown>) => {
		const entries = (params.dataSets as { values: Array<{ rows: string }> }).values;
		return {
			...params,
			documentId: documentLocator,
			maxWait: 2,
			pollEvery: 2,
			dataSets: { values: [{ dataSetId: DS_ID, rows: entries[0].rows }, { dataSetId: DS2_ID, rows: entries[1].rows }] },
		};
	};
	const fixtures = {
		'Get customers': customers.map((json) => ({ json })),
		'Get invoice lines': lines.map((json) => ({ json })),
	};

	it('emails only the customer whose file succeeded when another failed, and shows the failed one on the visible branch', async () => {
		const children = [
			runPayload({ id: 'child-0', split_key: customers[0].Email, status: 'succeeded', output_result: finished('Invoice Acme', 'https://docs.google.com/document/d/inv-0') }),
			runPayload({ id: 'child-1', split_key: customers[1].Email, status: 'failed', error_code: 'render_failed', error_message: 'Could not render.' }),
		];
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: RUN_ID, kind: 'batch', status: 'partial_success', file_count: 2 }) }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}/children`) return ok({ runs: children });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runTemplate('one-invoice-per-customer.json', { baseUrl: api.baseUrl, fixtures, pick: pickBoth });

		expect(result.run.status).toBe('success');
		expect(standInLog).toHaveLength(1);
		expect(standInLog[0].params.sendTo).toBe('ap@acme.test');
		expect(standInLog[0].params.message).toBe('Your invoice is ready: https://docs.google.com/document/d/inv-0');
		expect(result.json('Email the invoice')).toHaveLength(1);
		expect(result.json('No invoice, not emailed').map((item) => item.split_key)).toEqual(['ap@globex.test']);
	});

	it('stops the workflow with the failure when every file failed, which the sticky note and README say', async () => {
		const children = customers.slice(0, 2).map((c, i) => runPayload({ id: `child-${i}`, split_key: c.Email, status: 'failed', error_code: 'render_failed', error_message: 'Could not render.' }));
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: RUN_ID, kind: 'batch', status: 'failed', file_count: 2, error_message: 'Every file failed.' }) }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}/children`) return ok({ runs: children });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runTemplate('one-invoice-per-customer.json', { baseUrl: api.baseUrl, fixtures, pick: pickBoth });

		expect(result.errorOf('SourceToDocs')).toBeDefined();
		expect(standInLog).toHaveLength(0);
		expect(result.json('No invoice, not emailed')).toHaveLength(0);
	});

	it('keeps a partial_success file off the email branch, as the README says', async () => {
		const children = [runPayload({ id: 'child-0', split_key: customers[0].Email, status: 'partial_success', output_result: finished('Invoice Acme', 'https://docs.google.com/document/d/inv-0') })];
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: RUN_ID, kind: 'batch', status: 'partial_success', file_count: 1 }) }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}/children`) return ok({ runs: children });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runTemplate('one-invoice-per-customer.json', { baseUrl: api.baseUrl, fixtures, pick: pickBoth });

		expect(standInLog).toHaveLength(0);
		expect(result.json('No invoice, not emailed')).toHaveLength(1);
	});

	it('sends no email and does not fail the execution when the batch times out', async () => {
		const batch = runPayload({ id: RUN_ID, kind: 'batch', status: 'processing', file_count: 3 });
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: batch }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}`) return ok({ run: batch });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runTemplate('one-invoice-per-customer.json', { baseUrl: api.baseUrl, fixtures, pick: pickBoth });

		expect(result.run.status).toBe('success');
		expect(result.errorOf('SourceToDocs')).toBeUndefined();
		expect(result.errorOf('Email the invoice')).toBeUndefined();
		expect(standInLog).toHaveLength(0);
		expect(result.json('No invoice, not emailed')).toHaveLength(1);
		expect(result.json('No invoice, not emailed')[0]).toMatchObject({ timed_out: true });
	});

	it('sends no email and does not fail the execution when the batch produced nothing', async () => {
		const api = await startApi((request) => {
			if (request.method === 'POST') return ok({ run: runPayload({ id: RUN_ID, kind: 'batch', status: 'succeeded', file_count: 0 }) }, 201);
			if (request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(splitDocument);
			if (request.path === `${API_PATH}/runs/${RUN_ID}/children`) return ok({ runs: [] });
			return failure(404, 'not_found', 'Resource not found.');
		});

		const result = await runTemplate('one-invoice-per-customer.json', { baseUrl: api.baseUrl, fixtures, pick: pickBoth });

		expect(result.run.status).toBe('success');
		expect(standInLog).toHaveLength(0);
		expect(result.json('No invoice, not emailed')).toHaveLength(1);
	});
});
