/**
 * What a verifier and a person searching for the node read first: the package metadata, the codex
 * file's search aliases, the README's shape and the CHANGELOG's first release. The codex as n8n's
 * own loader reads it is in test-engine/test/codex.engine.test.ts.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals -- a test reads the repo's files; it is not shipped */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('package.json')) as { version: string; keywords: string[] };
const codex = JSON.parse(read('nodes/SourceToDocs/SourceToDocs.node.json')) as { alias?: string[] };

describe('package metadata', () => {
	it('is the first public release, 1.0.0', () => {
		expect(manifest.version).toBe('1.0.0');
	});

	it('keeps the community node keyword and carries the search terms', () => {
		expect(manifest.keywords).toContain('n8n-community-node-package');
		expect(manifest.keywords).toEqual(
			expect.arrayContaining(['invoice', 'report', 'pdf', 'google-slides', 'google-docs', 'presentation', 'document-automation', 'template', 'mail-merge']),
		);
	});

	it('gives the codex the aliases people search the nodes panel for', () => {
		expect(codex.alias?.map((alias) => alias.toLowerCase())).toEqual(
			expect.arrayContaining(['invoice', 'report', 'pdf', 'google slides', 'google docs', 'presentation', 'document generation', 'template', 'mail merge']),
		);
	});
});

describe('CHANGELOG', () => {
	const changelog = read('CHANGELOG.md');

	it('records one first release for the package version, and no development log', () => {
		expect(changelog).toMatch(new RegExp(`^## \\[${manifest.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
		expect(changelog.match(/^## \[/gm)).toHaveLength(1);
		expect(changelog).not.toContain('[Unreleased]');
		expect(changelog).not.toMatch(/^### (Changed|Fixed)/m);
	});
});

describe('README', () => {
	const readme = read('README.md');
	const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

	it("follows n8n's README skeleton, in its order", () => {
		const skeleton = ['Installation', 'Operations', 'Credentials', 'Compatibility', 'Usage', 'Resources', 'Version history'];
		const positions = skeleton.map((heading) => headings.indexOf(heading));

		expect(positions.every((position) => position >= 0), headings.join(', ')).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it('names the n8n version it was tested on', () => {
		expect(readme).toMatch(/## Compatibility[\s\S]*2\.36\.9/);
	});

	it('leaves no internal note in the public text', () => {
		expect(readme).not.toMatch(/No screenshots here|the spec'?s|verified without a browser|\bticket \d+/i);
	});

	it('states the request body limit and the row limit where it describes Rows and in Limits', () => {
		const rowsRow = readme.split('\n').find((line) => line.startsWith('| → Rows |')) ?? '';
		const limits = readme.slice(readme.indexOf('### Limits'));

		expect(rowsRow).toContain('2 MiB');
		expect(limits).toContain('2 MiB');
		expect(limits).toContain('request_body_too_large');
		expect(limits).toContain('source_too_large');
		expect(limits).toContain('100,000');
	});

	it('scopes an agent-filled Idempotency Key to the execution', () => {
		const aiTool = readme.slice(readme.indexOf('### Use it as an AI tool'), readme.indexOf('### Limits'));

		expect(aiTool).toContain("{{ $execution.id }}:{{ $fromAI('key'");
	});

	it('speaks to users only: running the node against a local or staging API lives in CONTRIBUTING', () => {
		expect(readme).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|staging|local (instance|API)|## Development/i);
		expect(readme).toContain('(CONTRIBUTING.md)');
	});
});

describe('CONTRIBUTING', () => {
	const contributing = read('CONTRIBUTING.md');

	it('gives a Docker recipe the https rule accepts', () => {
		expect(contributing).not.toMatch(/reaches the same API as `http:\/\/host\.docker\.internal/);
		expect(contributing).toContain('cloudflared tunnel');
		expect(contributing).toContain('https');
	});
});

describe('source comments', () => {
	const sources = (readdirSync(join(root, 'nodes'), { recursive: true }) as string[])
		.filter((path) => path.endsWith('.ts'))
		.map((path) => `nodes/${path}`)
		.concat('credentials/SourceToDocsApi.credentials.ts');

	it('cite no private spec labels, which a reader of the repository cannot resolve', () => {
		const label = /\b(?:[SDBRN]-?\d{1,2}|NB \d+|NS VULN-\d+|ST-\d+|ticket \d+)\b/;
		const cited = sources.flatMap((path) =>
			read(path)
				.split('\n')
				.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line) && label.test(line))
				.map((line) => `${path}: ${line.trim()}`),
		);

		expect(cited).toEqual([]);
	});
});

describe('every tracked text file', () => {
	// Words of the team's private process that mean nothing to a reader of the public repository. Some patterns
	// are assembled from parts so this file does not match itself; it is also left out of the scan.
	const label = '[SDBRNC]-?\\d{1,2}';
	const privateProcess = [
		/\bNB \d+/,
		/\bNS (?:VULN|VERIFY)-\d+/,
		/\bVULN-\d+/,
		/\bVERIFY-\d+/,
		/\bST-\d+/,
		/\bSP-\d+/,
		/\bticket \d+|\btickets? NN|later ticket/,
		/\bhandoffs?\b/,
		new RegExp('\\b' + 'au' + 'dit\\b'),
		new RegExp('\\.' + 'scratch\\b'),
		new RegExp('final ' + 'review'),
		new RegExp('publish ' + 'review'),
		new RegExp(`\\(${label}(?:, ?${label})*\\)`),
	];
	const skipped =
		/^(?:node_modules\/|dist\/|\.git\/|test-engine\/node_modules\/|\.agents\/)|(?:^|\/)\.vitest\/|(?:^|\/)package-lock\.json$|\.svg$|^(?:AGENTS|CLAUDE)\.md$|^test\/package\.test\.ts$/;

	it('mention none of them, in comments, titles, prose or data', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
				const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
				if (skipped.test(entry.isDirectory() ? `${path}/` : path)) continue;
				if (entry.isDirectory()) walk(path);
				else if (entry.isFile()) files.push(path);
			}
		};
		walk("");
		const found = files.flatMap((path) => {
			const bytes = readFileSync(join(root, path));
			if (bytes.includes(0)) return [];
			return bytes
				.toString('utf8')
				.split('\n')
				.flatMap((line, index) => (privateProcess.some((pattern) => pattern.test(line)) ? [`${path}:${index + 1}: ${line.trim()}`] : []));
		});

		expect(found).toEqual([]);
	});
});

describe('the release workflow', () => {
	const workflow = read('.github/workflows/release.yml');
	const jobs = new Map<string, string>();
	for (const chunk of workflow.split(/^jobs:\n/m)[1].split(/^ {2}(?=[a-z]+:\n)/m)) {
		if (chunk !== '') jobs.set(chunk.slice(0, chunk.indexOf(':')), chunk);
	}
	const runLines = (job: string) => [...(jobs.get(job) ?? '').matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]);

	it('has a pack job, a test job and a publish job', () => {
		expect([...jobs.keys()]).toEqual(['pack', 'test', 'publish']);
	});

	it('packs in a job that installs only the root package, with no install scripts, and never the engine test tree', () => {
		const commands = runLines('pack');

		expect(commands).toContain('npm ci --ignore-scripts');
		expect(commands.filter((command) => /\bnpm (?:--prefix|ci|install)\b/.test(command))).toEqual(['npm ci --ignore-scripts']);
		expect(commands.join('\n')).not.toContain('test-engine');
		expect(commands).not.toContain('npm test');
		expect(jobs.get('pack')).toContain('npm pack --ignore-scripts');
	});

	it('installs and runs the engine tests in the test job, which never packs', () => {
		const commands = runLines('test');

		expect(commands).toEqual(expect.arrayContaining(['npm ci', 'npm --prefix test-engine ci', 'npm test']));
		expect(commands.join('\n')).not.toContain('npm pack');
	});

	it('publishes only after both, with the only id-token, and checks the tarball against the sha256 pack recorded', () => {
		const publish = jobs.get('publish') ?? '';

		expect(publish).toContain('needs: [pack, test]');
		expect(workflow.match(/^\s+id-token: write$/gm)).toHaveLength(1);
		expect(publish).toContain('id-token: write');
		expect(publish).toContain('SHA256: ${{ needs.pack.outputs.sha256 }}');
		expect(publish).toContain('sha256sum --check');
	});

	it('pins every action to a full commit SHA', () => {
		const uses = [...workflow.matchAll(/^\s+uses: (\S+)/gm)].map((match) => match[1]);

		expect(uses.length).toBeGreaterThan(0);
		for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
	});
});
