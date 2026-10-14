/**
 * The engine test harness: the real `WorkflowExecute` from n8n-core 2.36.7 and the real
 * `Workflow` / expression engine from n8n-workflow 2.36.4 (the versions n8n 2.36.9 ships), the
 * node loaded from its compiled CommonJS build, and a local HTTP server standing in for the
 * Public API. The API is the only fake.
 *
 * Everything n8n is loaded through `require`, not `import`: n8n-workflow ships separate ESM and
 * CJS builds and n8n-core requires the CJS one. Importing the ESM build here would give the
 * test its own `NodeApiError`, and every `instanceof` in the node would fail.
 *
 * Written from our own spike; n8n's NodeTestHarness (under n8n's licence) was only read.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-hardcoded-secrets --
   test-only code in its own package, never shipped: it runs n8n itself and a local HTTP server,
   and TOKEN is a made-up string the fake API sees. */
import { afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import type * as WorkflowTypes from 'n8n-workflow';

const require = createRequire(import.meta.url);
const wf = require('n8n-workflow') as typeof WorkflowTypes;
const core = require('n8n-core');
const { SourceToDocs } = require('../node-dist/nodes/SourceToDocs/SourceToDocs.node.js');
const { SourceToDocsApi } = require('../node-dist/credentials/SourceToDocsApi.credentials.js');
const transport = require('../node-dist/nodes/SourceToDocs/transport/index.js');

/** The node's request limits. An engine test shortens `requestTimeoutMs` (30 s) and restores it. */
export const transportLimits = transport.transportLimits as { requestTimeoutMs: number; startRetryBackoffMs: number };

export { wf, core };

export { SourceToDocsApi };

export const S2D_TYPE = '@twovmodules/n8n-nodes-sourcetodocs.sourceToDocs';
export const TOKEN = 'wsk_engine_test_secret_token_123';

// ---------------------------------------------------------------------------------------------
// Stand-in node types
// ---------------------------------------------------------------------------------------------

/** Emits the items its `items` parameter (a JSON array of `{ json, binary? }`) holds. */
class EmitNode implements WorkflowTypes.INodeType {
	description: WorkflowTypes.INodeTypeDescription = {
		displayName: 'Emit',
		name: 'test.emit',
		group: ['input'],
		version: 1,
		description: 'Emits fixed items',
		defaults: { name: 'Emit' },
		inputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		outputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		properties: [{ displayName: 'Items', name: 'items', type: 'json', default: '[]' }],
	};

	async execute(this: WorkflowTypes.IExecuteFunctions) {
		const raw = this.getNodeParameter('items', 0) as string | unknown[];
		const items = (typeof raw === 'string' ? JSON.parse(raw) : raw) as WorkflowTypes.INodeExecutionData[];
		return [items];
	}
}

/** Evaluates its `value` parameter once per input item, like a Set node with one field. */
class CaptureNode implements WorkflowTypes.INodeType {
	description: WorkflowTypes.INodeTypeDescription = {
		displayName: 'Capture',
		name: 'test.capture',
		group: ['transform'],
		version: 1,
		description: 'Evaluates an expression per item',
		defaults: { name: 'Capture' },
		inputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		outputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		properties: [{ displayName: 'Value', name: 'value', type: 'string', default: '' }],
	};

	async execute(this: WorkflowTypes.IExecuteFunctions) {
		const items = this.getInputData();
		return [
			items.map((_item, i) => ({
				json: { value: this.getNodeParameter('value', i) as WorkflowTypes.IDataObject },
				pairedItem: { item: i },
			})),
		];
	}
}

/** What the engine hands a node, recorded by {@link ProbeNode} once per try. */
export interface ProbeSighting {
	executionId: string | undefined;
	nodeId: string;
	workflowId: string | undefined;
	runIndex: unknown;
	instanceId: unknown;
}

/** Every try of every probe node since the last `probeLog.length = 0`. */
export const probeLog: ProbeSighting[] = [];

/** Records the ids the engine exposes, and fails its first `failFirst` tries (to be retried by Retry On Fail). */
class ProbeNode implements WorkflowTypes.INodeType {
	description: WorkflowTypes.INodeTypeDescription = {
		displayName: 'Probe',
		name: 'test.probe',
		group: ['transform'],
		version: 1,
		description: 'Records what the engine exposes',
		defaults: { name: 'Probe' },
		inputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		outputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		properties: [{ displayName: 'Fail First', name: 'failFirst', type: 'number', default: 0 }],
	};

	async execute(this: WorkflowTypes.IExecuteFunctions) {
		let instanceId: unknown;
		try {
			instanceId = this.getInstanceId();
		} catch (error) {
			instanceId = `throws: ${String(error)}`;
		}
		probeLog.push({
			executionId: this.getExecutionId(),
			nodeId: this.getNode().id,
			workflowId: this.getWorkflow().id,
			runIndex: (this.getWorkflowDataProxy(0) as unknown as { $runIndex: unknown }).$runIndex,
			instanceId,
		});
		if (probeLog.length <= (this.getNodeParameter('failFirst', 0) as number)) throw new Error('probe failure');
		return [this.getInputData()];
	}
}

/**
 * Stands in for n8n's HTTP Request node, the one node that may use any credential unless the
 * credential restricts itself: it asks for the SourceToDocs credential and sends a request
 * with it, the way HTTP Request does with an "Existing credential type".
 */
class HttpRequestStandIn implements WorkflowTypes.INodeType {
	description: WorkflowTypes.INodeTypeDescription = {
		displayName: 'HTTP Request',
		name: 'httpRequest',
		group: ['output'],
		version: 1,
		description: 'Stand-in',
		defaults: { name: 'HTTP Request' },
		inputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		outputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
	};

	async execute(this: WorkflowTypes.IExecuteFunctions) {
		const url = this.getNodeParameter('url', 0) as string;
		const answer = await this.helpers.httpRequestWithAuthentication.call(this, 'sourceToDocsApi', { url, json: true });
		return [[{ json: { answer: answer as WorkflowTypes.IDataObject } }]];
	}
}

export const HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';


// ---------------------------------------------------------------------------------------------
// Stand-ins for the third-party nodes the templates use. Each emits fixture items in the real
// node's output shape (templates.engine.test.ts says where each shape comes from) and declares the
// parameters the template sets, because n8n drops a parameter its node type does not declare.
// ---------------------------------------------------------------------------------------------

/** Items a template stand-in emits, by the node's name in the template. Set by {@link runTemplate}. */
const standInFixtures: Record<string, WorkflowTypes.INodeExecutionData[]> = {};

/** What each sink stand-in received, per input item: its parameters as the template resolves them. */
export const standInLog: Array<{ node: string; item: number; params: Record<string, unknown> }> = [];

type StandInParams = Record<string, 'string' | 'json' | 'boolean'>;

function standInDescription(name: string, displayName: string, params: StandInParams, group: string, hasInput: boolean) {
	return {
		displayName,
		name,
		group: [group],
		version: 1,
		description: `Stand-in for ${displayName}`,
		defaults: { name: displayName },
		inputs: (hasInput ? ['main'] : []) as WorkflowTypes.NodeConnectionType[],
		outputs: ['main'] as WorkflowTypes.NodeConnectionType[],
		properties: Object.entries(params).map(([paramName, type]) => ({
			displayName: paramName,
			name: paramName,
			type,
			default: type === 'boolean' ? false : '',
		})),
	} as WorkflowTypes.INodeTypeDescription;
}

/**
 * A trigger or a read: emits the fixture its own node name carries, or hands on what it received.
 * `perInputItem` is a read like Airtable's Search, which runs once for every item it receives (so
 * Execute Once matters): the fixture comes out once per input item.
 */
function standInSource(
	name: string,
	displayName: string,
	params: StandInParams,
	group: string,
	hasInput: boolean,
	perInputItem = false,
): WorkflowTypes.INodeType {
	return {
		description: standInDescription(name, displayName, params, group, hasInput),
		async execute(this: WorkflowTypes.IExecuteFunctions) {
			const fixture = standInFixtures[this.getNode().name];
			if (fixture === undefined) return [this.getInputData()];
			if (!perInputItem) return [fixture];
			return [this.getInputData().flatMap(() => structuredClone(fixture))];
		},
	};
}

/** An action that sends something: resolves each declared parameter per item, logs it, emits `shape(item)`. */
function standInSink(
	name: string,
	displayName: string,
	params: StandInParams,
	shape: (item: WorkflowTypes.INodeExecutionData) => WorkflowTypes.IDataObject,
): WorkflowTypes.INodeType {
	return {
		description: standInDescription(name, displayName, params, 'output', true),
		async execute(this: WorkflowTypes.IExecuteFunctions) {
			const out: WorkflowTypes.INodeExecutionData[] = [];
			this.getInputData().forEach((item, index) => {
				const resolved: Record<string, unknown> = {};
				for (const paramName of Object.keys(params)) resolved[paramName] = this.getNodeParameter(paramName, index);
				standInLog.push({ node: this.getNode().name, item: index, params: resolved });
				out.push({ json: shape(item), pairedItem: { item: index } });
			});
			return [out];
		},
	};
}

/**
 * n8n's If (v2.2), reduced to what the templates use: a list of boolean "is true" conditions joined
 * with AND. The `conditions` parameter is resolved by n8n's expression engine against each item, so
 * the template's own expression decides; the item goes to output 0 when every condition is true,
 * else to output 1. (Real If's other operators are not needed by any template.)
 */
function standInIf(): WorkflowTypes.INodeType {
	return {
		description: {
			...standInDescription('test.if', 'If', { conditions: 'json', options: 'json' }, 'transform', true),
			outputs: ['main', 'main'] as WorkflowTypes.NodeConnectionType[],
		},
		async execute(this: WorkflowTypes.IExecuteFunctions) {
			const passed: WorkflowTypes.INodeExecutionData[] = [];
			const refused: WorkflowTypes.INodeExecutionData[] = [];
			this.getInputData().forEach((item, index) => {
				const { conditions } = this.getNodeParameter('conditions', index) as {
					conditions: Array<{ leftValue: unknown; operator: { type: string; operation: string } }>;
				};
				const every = conditions.every((condition) => {
					if (condition.operator.type !== 'boolean' || condition.operator.operation !== 'true') {
						throw new Error(`the If stand-in does not know ${condition.operator.type}:${condition.operator.operation}`);
					}
					return condition.leftValue === true;
				});
				(every ? passed : refused).push({ json: item.json, pairedItem: { item: index } });
			});
			return [passed, refused];
		},
	};
}

/** The third-party (and n8n core) node types the three templates use, and the stand-in type each becomes. */
export const TEMPLATE_STAND_INS: Record<string, string> = {
	'n8n-nodes-base.manualTrigger': 'test.manualTrigger',
	'n8n-nodes-base.scheduleTrigger': 'test.scheduleTrigger',
	'n8n-nodes-base.formTrigger': 'test.formTrigger',
	'n8n-nodes-base.airtable': 'test.airtable',
	'n8n-nodes-base.slack': 'test.slack',
	'n8n-nodes-base.gmail': 'test.gmail',
	'n8n-nodes-base.form': 'test.form',
	'n8n-nodes-base.stickyNote': 'test.stickyNote',
	'n8n-nodes-base.if': 'test.if',
	'n8n-nodes-base.noOp': 'test.noOp',
};

const TEMPLATE_STAND_IN_NODES: Record<string, WorkflowTypes.INodeType> = {
	'test.manualTrigger': standInSource('test.manualTrigger', 'Manual Trigger', {}, 'trigger', true),
	'test.scheduleTrigger': standInSource('test.scheduleTrigger', 'Schedule Trigger', { rule: 'json' }, 'trigger', true),
	'test.formTrigger': standInSource(
		'test.formTrigger',
		'n8n Form Trigger',
		{ formTitle: 'string', formDescription: 'string', formFields: 'json' },
		'trigger',
		true,
	),
	'test.airtable': standInSource(
		'test.airtable',
		'Airtable',
		{ resource: 'string', operation: 'string', base: 'json', table: 'json', returnAll: 'boolean' },
		'input',
		true,
		true,
	),
	'test.slack': standInSink(
		'test.slack',
		'Slack',
		{ resource: 'string', operation: 'string', select: 'string', channelId: 'json', messageType: 'string', text: 'string' },
		(item) => ({ ok: true, channel: 'C0123456789', message_timestamp: '1760000000.000100', message: { type: 'message', text: String(item.json.file_url ?? '') } }),
	),
	'test.gmail': standInSink(
		'test.gmail',
		'Gmail',
		{ resource: 'string', operation: 'string', sendTo: 'string', subject: 'string', emailType: 'string', message: 'string' },
		() => ({ id: '19a0c0ffee000001', threadId: '19a0c0ffee000001', labelIds: ['SENT'] }),
	),
	// n8n Form, Form Ending page: the node hands its input item on.
	'test.form': standInSink(
		'test.form',
		'n8n Form',
		{ operation: 'string', respondWith: 'string', completionTitle: 'string', completionMessage: 'string' },
		(item) => item.json,
	),
	'test.if': standInIf(),
	// No Operation hands its items on.
	'test.noOp': standInSource('test.noOp', 'No Operation, do nothing', {}, 'input', true),
	// Sticky notes are never executed (nothing connects to them); the type only has to exist.
	'test.stickyNote': standInSource('test.stickyNote', 'Sticky Note', { content: 'string', height: 'string', width: 'string' }, 'input', false),
};

const NODE_TYPES: Record<string, WorkflowTypes.INodeType> = {
	...TEMPLATE_STAND_IN_NODES,
	[HTTP_REQUEST_TYPE]: new HttpRequestStandIn(),
	'test.emit': new EmitNode(),
	'test.capture': new CaptureNode(),
	'test.probe': new ProbeNode(),
	[S2D_TYPE]: new SourceToDocs(),
	// n8n generates an AI tool variant of a node and lets it use the credential too.
	[`${S2D_TYPE}Tool`]: new SourceToDocs(),
};

/** The node's description as the engine loads it, for tests that compute parameters the way n8n does. */
export const s2dDescription = NODE_TYPES[S2D_TYPE].description;

const nodeTypes: WorkflowTypes.INodeTypes = {
	getByName: (type) => NODE_TYPES[type],
	getByNameAndVersion: (type, version) => wf.NodeHelpers.getVersionedNodeType(NODE_TYPES[type], version),
	getKnownTypes: () => ({}),
};

// ---------------------------------------------------------------------------------------------
// Credentials: decrypted data comes from a map; the generic `authenticate` block is applied the
// way packages/cli's CredentialsHelper applies it, each key and value resolved as an expression
// against `$credentials` through the workflow's real expression engine.
// ---------------------------------------------------------------------------------------------

const CREDENTIAL_TYPES: Record<string, WorkflowTypes.ICredentialType> = {
	sourceToDocsApi: new SourceToDocsApi(),
};

class TestCredentialsHelper extends wf.ICredentialsHelper {
	constructor(private readonly data: Record<string, WorkflowTypes.ICredentialDataDecryptedObject>) {
		super();
	}

	getParentTypes(): string[] {
		return [];
	}

	isCredentialUsableByNode(credentialType: string, nodeType: string): boolean {
		const type = CREDENTIAL_TYPES[credentialType];
		if (type?.restrictToSupportedNodes !== true) return true;
		// n8n derives the list from the node descriptions that name the credential, prefixed with the
		// package name, and adds the generated AI tool variant of each (`<name>Tool`).
		const supported = (type.supportedNodes ?? []).flatMap((name) => [`@twovmodules/n8n-nodes-sourcetodocs.${name}`, `@twovmodules/n8n-nodes-sourcetodocs.${name}Tool`]);
		return supported.includes(nodeType);
	}

	async authenticate(
		credentials: WorkflowTypes.ICredentialDataDecryptedObject,
		typeName: string,
		requestOptions: WorkflowTypes.IHttpRequestOptions,
		workflow?: WorkflowTypes.Workflow,
		node?: WorkflowTypes.INode,
	): Promise<WorkflowTypes.IHttpRequestOptions> {
		const authenticate = CREDENTIAL_TYPES[typeName].authenticate;
		if (typeof authenticate === 'function') return await authenticate(credentials, requestOptions);
		if (authenticate?.type === 'generic' && workflow && node) {
			const resolve = (value: string) =>
				wf.isExpression(value)
					? (workflow.expression.getSimpleParameterValue(
							node,
							value,
							'internal',
							{ $credentials: credentials } as WorkflowTypes.IWorkflowDataProxyAdditionalKeys,
							undefined,
							'',
						) as string)
					: value;
			for (const [outerKey, outerValue] of Object.entries(authenticate.properties)) {
				const target = ((requestOptions as unknown as Record<string, Record<string, unknown>>)[outerKey] ??= {});
				for (const [key, value] of Object.entries(outerValue as Record<string, string>)) {
					target[resolve(key)] = resolve(value);
				}
			}
		}
		return requestOptions;
	}

	async preAuthentication() {
		return undefined;
	}

	async runPreAuthentication() {
		return undefined;
	}

	async getCredentials(): Promise<never> {
		throw new Error('getCredentials is not used by the node');
	}

	async getDecrypted(
		_additionalData: unknown,
		_nodeCredentials: unknown,
		type: string,
	): Promise<WorkflowTypes.ICredentialDataDecryptedObject> {
		return { ...(this.data[type] ?? {}) };
	}

	async updateCredentials() {}

	async updateCredentialsOauthTokenData() {}

	getCredentialsProperties() {
		return [];
	}
}

// ---------------------------------------------------------------------------------------------
// The fake Public API on 127.0.0.1
// ---------------------------------------------------------------------------------------------

export interface RecordedRequest {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	/** Parsed JSON when the body is JSON, the raw text otherwise, `undefined` when empty. */
	body: unknown;
}

/**
 * What a start POST carried apart from `idempotency_key`, which the node now always sends: the
 * other fields, or `undefined` when there are none. Tests that check the rest of a body use this.
 */
export function bodyOf(request: RecordedRequest): unknown {
	if (typeof request.body !== 'object' || request.body === null) return request.body;
	const rest = { ...(request.body as Record<string, unknown>) };
	delete rest.idempotency_key;
	return Object.keys(rest).length === 0 ? undefined : rest;
}

export interface FakeReply {
	status: number;
	body?: unknown;
	/** A raw text body, sent as it is (an HTML error page, a plain-text 413); wins over `body`. */
	raw?: string;
	headers?: Record<string, string>;
}

/** `status: 0` never answers; `status: -1` drops the connection (a reset socket). A router that throws becomes a 500. */
export type Router = (request: RecordedRequest, all: RecordedRequest[]) => FakeReply;

export interface FakeApi {
	origin: string;
	/** `<origin>/api/public/v1`, the credential's Base URL. */
	baseUrl: string;
	requests: RecordedRequest[];
	posts: () => RecordedRequest[];
	gets: () => RecordedRequest[];
	close: () => Promise<void>;
}

export async function startFakeApi(router: Router): Promise<FakeApi> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			let body: unknown = raw === '' ? undefined : raw;
			try {
				if (raw !== '') body = JSON.parse(raw);
			} catch {
				// keep the raw text
			}
			const recorded: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
			requests.push(recorded);
			let reply: FakeReply;
			try {
				reply = router(recorded, requests);
			} catch (error) {
				reply = { status: 500, body: { router_error: String(error) } };
			}
			if (reply.status === 0) return;
			if (reply.status === -1) {
				req.socket.destroy();
				return;
			}
			res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
			res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		baseUrl: `${origin}/api/public/v1`,
		requests,
		posts: () => requests.filter((r) => r.method === 'POST'),
		gets: () => requests.filter((r) => r.method === 'GET'),
		close: () =>
			new Promise<void>((resolve) => {
				// axios keeps sockets alive, which would hold `close()` open.
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/**
 * Starts fake APIs for a test file and closes every one after each test, or, with
 * `{ concurrent: true }` (for `describe.concurrent`), once after the whole file.
 */
export function useFakeApis({ concurrent = false } = {}): (router?: Router) => Promise<FakeApi> {
	let started: FakeApi[] = [];
	const closeAll = async () => {
		await Promise.all(started.map((api) => api.close()));
		started = [];
	};
	if (concurrent) afterAll(closeAll);
	else afterEach(closeAll);
	return async (router = defaultRouter()) => {
		const api = await startFakeApi(router);
		started.push(api);
		return api;
	};
}

// ---------------------------------------------------------------------------------------------
// Running a workflow
// ---------------------------------------------------------------------------------------------

export interface TestNode extends Partial<WorkflowTypes.INode> {
	name: string;
	type: string;
	parameters: WorkflowTypes.INodeParameters;
}

export interface RunOptions {
	nodes: TestNode[];
	/** `[from, to]` on main output 0, or `[from, to, outputIndex]`. */
	connections: Array<[string, string] | [string, string, number]>;
	/** The node the engine starts from; it receives one empty item. */
	start?: string;
	/** The credential's Base URL: `api.baseUrl`. */
	baseUrl: string;
	/** Defaults to `executionOrder: 'v1'`: `{}` silently runs the legacy v0 order (pitfall 4). */
	settings?: WorkflowTypes.IWorkflowSettings;
	token?: string;
	/** n8n's execution id as the node sees it; defaults to '1'. */
	executionId?: string;
	/** Stops the execution this many ms after it started, the way the editor's Stop does (the cancel signal fires). */
	cancelAfterMs?: number;
}

export interface RunResult {
	run: WorkflowTypes.IRun;
	/** Items of each node's main outputs, per run: `out[node][runIndex][outputIndex]`. */
	out: Record<string, Array<WorkflowTypes.INodeExecutionData[][]>>;
	/** Shorthand for `out[node][runIndex][outputIndex] ?? []` mapped to the items' json. */
	json: (node: string, runIndex?: number, outputIndex?: number) => WorkflowTypes.IDataObject[];
	items: (node: string, runIndex?: number, outputIndex?: number) => WorkflowTypes.INodeExecutionData[];
	errorOf: (node: string, runIndex?: number) => WorkflowTypes.ExecutionError | undefined;
	/** The execution hints a node added on one run (`addExecutionHints`), as the engine stores them in the run data. */
	hintsOf: (node: string, runIndex?: number) => WorkflowTypes.NodeExecutionHint[];
	/** Node names in the order they finished. */
	order: string[];
	ms: number;
}

/**
 * The least `IWorkflowExecuteAdditionalData` the node and the engine touch (measured by adding
 * fields until the runs passed). The waiting URLs are needed or `appendResumeToken` throws
 * `Invalid URL`.
 */
function makeAdditionalData(
	hooks: unknown,
	baseUrl: string,
	token = TOKEN,
	extra: Record<string, unknown> = {},
): WorkflowTypes.IWorkflowExecuteAdditionalData {
	return {
		executionId: '1',
		hooks,
		webhookWaitingBaseUrl: 'http://localhost:5678/webhook-waiting',
		formWaitingBaseUrl: 'http://localhost:5678/form-waiting',
		credentialsHelper: new TestCredentialsHelper({ sourceToDocsApi: { apiToken: token, baseUrl } }),
		...extra,
	} as unknown as WorkflowTypes.IWorkflowExecuteAdditionalData;
}

/**
 * Builds a real `Workflow` and runs it with `WorkflowExecute`. A literal parameter value that
 * n8n validates before the run makes this reject with `WorkflowHasIssuesError`; use an
 * expression when a test needs the node itself to see a bad value.
 */
export async function runWorkflow(options: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const nodes: WorkflowTypes.INode[] = options.nodes.map((node, index) => ({
		id: `node-${index}`,
		typeVersion: 1,
		position: [index * 200, 0],
		...node,
		...(node.type === S2D_TYPE
			? { credentials: { sourceToDocsApi: { id: 'cred-1', name: 'SourceToDocs account' } } }
			: {}),
	}));

	const connections: WorkflowTypes.IConnections = {};
	for (const [from, to, outputIndex = 0] of options.connections) {
		connections[from] ??= { main: [] };
		const main = connections[from].main as WorkflowTypes.IConnection[][];
		while (main.length <= outputIndex) main.push([]);
		main[outputIndex].push({ node: to, type: 'main', index: 0 });
	}

	const settings = options.settings ?? { executionOrder: 'v1' };
	const workflow = new wf.Workflow({
		id: 'engine-test',
		name: 'engine-test',
		nodes,
		connections,
		nodeTypes,
		active: false,
		settings,
	});

	const order: string[] = [];
	const hooks = new core.ExecutionLifecycleHooks('manual', '1', {
		id: 'engine-test',
		name: 'engine-test',
		nodes,
		connections,
		settings,
		active: false,
		isArchived: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	hooks.addHandler('nodeExecuteAfter', (nodeName: string) => {
		order.push(nodeName);
	});

	const additionalData = makeAdditionalData(hooks, options.baseUrl, options.token, {
		executionId: options.executionId ?? '1',
	});

	const startName = options.start ?? options.nodes[0].name;
	const startNode = workflow.getNode(startName);
	if (startNode === null) throw new Error(`no node ${startName}`);
	const runExecutionData = wf.createRunExecutionData({
		executionData: {
			nodeExecutionStack: [{ node: startNode, data: { main: [[{ json: {} }]] }, source: null }],
			waitingExecutionSource: null,
		},
	});

	const workflowExecute = new core.WorkflowExecute(additionalData, 'manual', runExecutionData);
	const running = workflowExecute.processRunExecutionData(workflow);
	if (options.cancelAfterMs !== undefined) void wf.sleep(options.cancelAfterMs).then(() => running.cancel());
	const run = (await running) as WorkflowTypes.IRun;

	const out: RunResult['out'] = {};
	for (const [name, tasks] of Object.entries(run.data.resultData.runData)) {
		out[name] = tasks.map((task) => (task.data?.main ?? []) as WorkflowTypes.INodeExecutionData[][]);
	}
	const items = (node: string, runIndex = 0, outputIndex = 0) => out[node]?.[runIndex]?.[outputIndex] ?? [];
	return {
		run,
		out,
		items,
		json: (node, runIndex, outputIndex) => items(node, runIndex, outputIndex).map((item) => item.json),
		errorOf: (node, runIndex = 0) => run.data.resultData.runData[node]?.[runIndex]?.error,
		hintsOf: (node, runIndex = 0) => run.data.resultData.runData[node]?.[runIndex]?.hints ?? [],
		order,
		ms: Date.now() - started,
	};
}

export interface ToolRunOptions {
	/** The tool node's parameters (the node is the `…Tool` variant; Generate, "don't wait" unless set). */
	node: TestNode;
	baseUrl: string;
	/** One entry per invocation, in order: what the agent passes as the tool's arguments. */
	calls: WorkflowTypes.IDataObject[];
	executionId?: string;
}

export interface ToolRunResult {
	/** Per call: the JSON string the tool returned, or the error it threw. */
	outcomes: Array<{ response: string } | { error: Error }>;
}

/**
 * Invokes the node's AI tool variant the way n8n's in-process tool path does: n8n-core's own
 * `makeHandleToolInvocation` over a `SupplyDataContext` (what an AI Agent 3.1 does not use, but the
 * MCP Server Trigger and any in-process consumer do). Its Retry On Fail loop raises the run index on
 * every try. `makeHandleToolInvocation` is required by absolute path: n8n-core's exports do not list it.
 */
export async function runAsTool(options: ToolRunOptions): Promise<ToolRunResult> {
	const coreDir = resolvePath(require.resolve('n8n-core'), '..', 'execution-engine', 'node-execution-context');
	const { makeHandleToolInvocation } = require(resolvePath(coreDir, 'utils', 'get-input-connection-data.js'));
	const { SupplyDataContext } = require(resolvePath(coreDir, 'supply-data-context.js'));

	const parent: WorkflowTypes.INode = { id: 'parent-0', name: 'Parent', type: 'test.emit', typeVersion: 1, position: [0, 0], parameters: { items: '[]' } };
	const tool: WorkflowTypes.INode = {
		id: 'node-1',
		typeVersion: 1,
		position: [200, 0],
		...options.node,
		credentials: { sourceToDocsApi: { id: 'cred-1', name: 'SourceToDocs account' } },
	};
	const workflow = new wf.Workflow({
		id: 'engine-test',
		name: 'engine-test',
		nodes: [parent, tool],
		connections: {},
		nodeTypes,
		active: false,
		settings: { executionOrder: 'v1' },
	});
	const additionalData = makeAdditionalData(undefined, options.baseUrl, TOKEN, { executionId: options.executionId ?? '1', currentNodeExecutionIndex: 0 });
	const runExecutionData = wf.createRunExecutionData({});
	const connectionInputData = [{ json: {} }];
	const executeData = { node: tool, data: { main: [connectionInputData] }, source: null };
	const contextFactory = (runIndex: number) =>
		new SupplyDataContext(workflow, tool, additionalData, 'manual', runExecutionData, runIndex, connectionInputData, {}, 'ai_tool', executeData, [], undefined, parent);

	const invoke = makeHandleToolInvocation(contextFactory, tool, NODE_TYPES[tool.type], runExecutionData) as (args: WorkflowTypes.IDataObject) => Promise<string>;
	const outcomes: ToolRunResult['outcomes'] = [];
	for (const args of options.calls) {
		try {
			outcomes.push({ response: await invoke(args) });
		} catch (error) {
			outcomes.push({ error: error as Error });
		}
	}
	return { outcomes };
}

/** An expression the credential class holds (its `test.request.baseURL`), resolved against `$credentials`. */
export function evalWithCredentials(expression: string, credentials: Record<string, string>): unknown {
	const node: WorkflowTypes.INode = {
		id: 'node-0',
		name: 'Probe',
		type: 'test.emit',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	const workflow = new wf.Workflow({
		id: 'engine-test',
		name: 'engine-test',
		nodes: [node],
		connections: {},
		nodeTypes,
		active: false,
		settings: { executionOrder: 'v1' },
	});
	return workflow.expression.getSimpleParameterValue(
		node,
		expression,
		'internal',
		{ $credentials: credentials } as WorkflowTypes.IWorkflowDataProxyAdditionalKeys,
		undefined,
		'',
	);
}

// ---------------------------------------------------------------------------------------------
// Templates: the JSON files under templates/, loaded as they are
// ---------------------------------------------------------------------------------------------

interface TemplateNode {
	id: string;
	name: string;
	type: string;
	typeVersion: number;
	position: [number, number];
	parameters: WorkflowTypes.INodeParameters;
	executeOnce?: boolean;
	credentials?: unknown;
}

export interface TemplateFile {
	name: string;
	nodes: TemplateNode[];
	connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
	settings: WorkflowTypes.IWorkflowSettings;
}

/** Reads `templates/<file>` from the repository root, untouched. */
export function readTemplate(file: string): TemplateFile {
	return JSON.parse(readFileSync(resolvePath(fileURLToPath(import.meta.url), '../../../templates', file), 'utf8')) as TemplateFile;
}

export interface TemplateRun {
	/** Items a stand-in node emits, by node name. A node with none hands on what it received. */
	fixtures: Record<string, WorkflowTypes.INodeExecutionData[]>;
	/** What the person does after import: pick a Document and Data Sets on the SourceToDocs node. */
	pick: (s2dParameters: WorkflowTypes.INodeParameters) => WorkflowTypes.INodeParameters;
	baseUrl: string;
}

/**
 * Runs a template file as it is, swapping only the node types in {@link TEMPLATE_STAND_INS} for stand-ins.
 * The template's own `typeVersion`, `executeOnce`, `settings` and connections are used unchanged, and the
 * run starts at the trigger. `pick` plays the person choosing their own Document and Data Sets.
 */
export async function runTemplate(file: string, options: TemplateRun): Promise<RunResult & { template: TemplateFile }> {
	const template = readTemplate(file);
	const unknown = template.nodes.map((n) => n.type).filter((type) => type !== S2D_TYPE && !(type in TEMPLATE_STAND_INS));
	if (unknown.length > 0) throw new Error(`no stand-in for ${unknown.join(', ')}`);

	for (const key of Object.keys(standInFixtures)) delete standInFixtures[key];
	Object.assign(standInFixtures, options.fixtures);
	standInLog.length = 0;

	const nodes: TestNode[] = template.nodes.map((n) => ({
		id: n.id,
		name: n.name,
		type: n.type === S2D_TYPE ? S2D_TYPE : TEMPLATE_STAND_INS[n.type],
		typeVersion: n.typeVersion,
		position: n.position,
		...(n.executeOnce === undefined ? {} : { executeOnce: n.executeOnce }),
		parameters: n.type === S2D_TYPE ? options.pick(structuredClone(n.parameters)) : structuredClone(n.parameters),
	}));

	const connections: RunOptions['connections'] = [];
	const targets = new Set<string>();
	for (const [from, byType] of Object.entries(template.connections)) {
		byType.main.forEach((outputs, outputIndex) => {
			for (const target of outputs) {
				connections.push([from, target.node, outputIndex]);
				targets.add(target.node);
			}
		});
	}
	const start = template.nodes.find((n) => n.name in template.connections && !targets.has(n.name));
	if (start === undefined) throw new Error('the template has no trigger');

	const result = await runWorkflow({ nodes, connections, start: start.name, baseUrl: options.baseUrl, settings: template.settings });
	return { ...result, template };
}

// ---------------------------------------------------------------------------------------------
// The node's methods (load options, list search, resource mapping), run through n8n-core's own
// LoadOptionsContext, which is what n8n's CLI builds for the editor's pickers.
// ---------------------------------------------------------------------------------------------

type MethodKind = 'loadOptions' | 'listSearch' | 'resourceMapping';

export interface MethodCall {
	kind: MethodKind;
	name: string;
	/** The node's parameters as the editor holds them while the picker loads. */
	parameters: WorkflowTypes.INodeParameters;
	/** `listSearch` only: the typed filter. */
	filter?: string;
	baseUrl: string;
	token?: string;
}

/**
 * Runs one of the node's methods exactly as n8n's CLI does: `LoadOptionsContext` from n8n-core
 * with the real expression engine and our credentials helper, then `methods[kind][name]` called
 * with that context as `this`.
 */
export async function callMethod<T = unknown>(call: MethodCall): Promise<T> {
	const node: WorkflowTypes.INode = {
		id: 'node-0',
		name: 'SourceToDocs',
		type: S2D_TYPE,
		typeVersion: 1,
		position: [0, 0],
		parameters: call.parameters,
		credentials: { sourceToDocsApi: { id: 'cred-1', name: 'SourceToDocs account' } },
	};
	const workflow = new wf.Workflow({
		id: 'engine-test',
		name: 'engine-test',
		nodes: [node],
		connections: {},
		nodeTypes,
		active: false,
		settings: { executionOrder: 'v1' },
	});
	const additionalData = makeAdditionalData(undefined, call.baseUrl, call.token, {
		currentNodeParameters: call.parameters,
	});
	const context = new core.LoadOptionsContext(workflow, node, additionalData, `${call.kind}.${call.name}`);
	const nodeType = NODE_TYPES[S2D_TYPE] as unknown as {
		methods: Record<MethodKind, Record<string, (this: unknown, ...args: unknown[]) => Promise<unknown>>>;
	};
	const method = nodeType.methods[call.kind][call.name];
	if (method === undefined) throw new Error(`the node has no ${call.kind}.${call.name}`);
	return (await (call.kind === 'listSearch' ? method.call(context, call.filter) : method.call(context))) as T;
}

// ---------------------------------------------------------------------------------------------
// Public API fixtures
// ---------------------------------------------------------------------------------------------

export const DOC_ID = '9f1c2a4e-3b77-4a51-9e2d-7c1f0b8ad4e6';
export const DS_ID = '11111111-2222-4333-8444-555555555555';
export const DS2_ID = '22222222-3333-4444-8555-666666666666';
export const API_PATH = '/api/public/v1';

export const documentPayload = {
	success: true,
	data: {
		document: {
			id: DOC_ID,
			project_id: 'a0000000-0000-4000-8000-000000000001',
			name: 'Report',
			type: 'google_docs',
			split_enabled: false,
			generate_pdf: false,
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			split: null,
			data_sets: [
				{
					id: DS_ID,
					name: 'Clients',
					alias: 'clients',
					data_source_id: 'src-1',
					source_table_id: 'tbl-1',
					columns: [
						{ name: 'Client name', type: 'text', selected: true },
						{ name: 'Amount', type: 'number', selected: true },
						{ name: 'Due', type: 'date', selected: true },
						{ name: 'Paid', type: 'bool', selected: true },
						{ name: 'Owner', type: 'relation', selected: false },
					],
				},
				{
					id: DS2_ID,
					name: 'Lines',
					alias: 'lines',
					data_source_id: 'src-1',
					source_table_id: 'tbl-2',
					columns: [{ name: 'Sku', type: 'text', selected: true }],
				},
			],
			distributions: [],
		},
	},
};

export function runPayload(overrides: Record<string, unknown> = {}) {
	return {
		id: 'b0000000-0000-4000-8000-000000000001',
		document_id: DOC_ID,
		workspace_id: 'ws-1',
		kind: 'single',
		split_key: null,
		idempotency_key: 'k',
		status: 'pending',
		file_count: null,
		progress: null,
		generation_stats: null,
		output_result: null,
		error_code: null,
		error_message: null,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		distributions: [],
		destinations: [],
		warnings: [],
		...overrides,
	};
}

export const ok = (data: unknown, status = 200): FakeReply => ({ status, body: { success: true, data } });

export function failure(status: number, category: string, message: string, errors: unknown = []): FakeReply {
	return { status, body: { success: false, category, message, errors } };
}

/** The ordinary router: the document read, a created run, and the run read, with `run` overriding. */
export function defaultRouter(run: Record<string, unknown> = {}): Router {
	return (request) => {
		if (request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`) return ok(documentPayload.data);
		if (request.method === 'POST' && request.path.endsWith('/runs')) return ok({ run: runPayload(run) }, 201);
		if (request.method === 'GET' && request.path.startsWith(`${API_PATH}/runs/`)) return ok({ run: runPayload(run) });
		return failure(404, 'not_found', 'Resource not found.');
	};
}

/**
 * The ordinary router, but the document read answers with `overrides` on top of the fixture
 * (for example a `split` with its key columns).
 */
export function documentRouter(overrides: Record<string, unknown>, run: Record<string, unknown> = {}): Router {
	const defaults = defaultRouter(run);
	return (request, all) =>
		request.method === 'GET' && request.path === `${API_PATH}/documents/${DOC_ID}`
			? ok({ document: { ...documentPayload.data.document, ...overrides } })
			: defaults(request, all);
}

/** A split document whose key is `columns` of the Data Set `dataSetId`. */
export const splitOn = (columns: string[], dataSetId = DS_ID, enabled = true) => ({
	split: {
		enabled,
		driver_data_source_id: 'src-1',
		driver_source_table_id: 'tbl-1',
		key: { data_set_id: dataSetId, columns },
	},
});

// ---------------------------------------------------------------------------------------------
// Workflow builders
// ---------------------------------------------------------------------------------------------

export function emit(items: unknown[], name = 'Emit'): TestNode {
	return { name, type: 'test.emit', parameters: { items: JSON.stringify(items) } };
}

export function capture(value: string, name = 'Capture'): TestNode {
	return { name, type: 'test.capture', parameters: { value } };
}

export const columnsSchema = [
	{ id: 'Client name', displayName: 'Client name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false, removed: false },
	{ id: 'Amount', displayName: 'Amount', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false, removed: false },
	{ id: 'Due', displayName: 'Due', required: false, defaultMatch: false, display: true, type: 'dateTime', canBeUsedToMatch: false, removed: false },
	{ id: 'Paid', displayName: 'Paid', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false, removed: false },
	{ id: 'Owner', displayName: 'Owner', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false, removed: true },
];

/** Values for every shown column but `Client name`, for a test that wants nothing left empty. */
export const otherShown = { Amount: 1, Due: '2026-01-01', Paid: true };

const documentLocator = { __rl: true, mode: 'id', value: DOC_ID };

/** The SourceToDocs node, Document → Generate, any parameters on top of "don't wait". */
export function s2d(parameters: WorkflowTypes.INodeParameters, extra: Partial<WorkflowTypes.INode> = {}): TestNode {
	return {
		name: 'SourceToDocs',
		type: S2D_TYPE,
		...extra,
		parameters: {
			resource: 'document',
			operation: 'generate',
			documentId: documentLocator,
			waitForCompletion: false,
			...parameters,
		} as WorkflowTypes.INodeParameters,
	};
}

/** Rows Come From: Connected Data Sources. */
export function s2dConnected(parameters: WorkflowTypes.INodeParameters = {}, extra: Partial<WorkflowTypes.INode> = {}): TestNode {
	return s2d({ rowsFrom: 'connected', ...parameters }, extra);
}

/** Rows Come From: This Workflow, JSON. `entries` are the Data Sets collection's rows. */
export function s2dJson(
	entries: Array<{ dataSetId: string; rows: unknown }>,
	parameters: WorkflowTypes.INodeParameters = {},
	extra: Partial<WorkflowTypes.INode> = {},
): TestNode {
	return s2d({ rowsFrom: 'workflow', dataSets: { values: entries as WorkflowTypes.INodeParameters[] }, ...parameters }, extra);
}

/** Rows Come From: Map Columns. `value` is the resource mapper's `columns.value`. */
export function s2dMapped(
	value: Record<string, unknown> | null,
	parameters: WorkflowTypes.INodeParameters = {},
	mappingMode = 'defineBelow',
	extra: Partial<WorkflowTypes.INode> = {},
): TestNode {
	return s2d(
		{
			rowsFrom: 'mapped',
			mappedDataSetId: DS_ID,
			columns: {
				mappingMode,
				value: value as WorkflowTypes.INodeParameters | null,
				matchingColumns: [],
				schema: columnsSchema,
				attemptToConvertTypes: false,
				convertFieldsToString: false,
			},
			...parameters,
		},
		extra,
	);
}

/** One Emit node feeding the SourceToDocs node: the shape of most tests. */
export function emitInto(items: unknown[], node: TestNode, baseUrl: string): RunOptions {
	return { baseUrl, nodes: [emit(items), node], connections: [['Emit', node.name]] };
}
