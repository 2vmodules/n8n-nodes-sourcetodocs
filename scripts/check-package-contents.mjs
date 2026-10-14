// Fails when `npm pack --dry-run` lists anything but the compiled node and credential and the package's
// metadata. `n8n-node build` copies every png/svg it finds (it skips only the top-level node_modules), so
// the assets of `test-engine/node_modules` land in `dist/test-engine`; `tsc` also writes
// `dist/tsconfig.tsbuildinfo`. The `files` list in package.json keeps both out: this guards that list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowed = [/^dist\/nodes\//, /^dist\/credentials\//];
const metadata = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'ignore'],
});
const files = JSON.parse(out)[0].files.map((file) => file.path);

const stray = files.filter(
	(path) => !metadata.has(path) && !allowed.some((rule) => rule.test(path)),
);

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = [...(manifest.n8n?.nodes ?? []), ...(manifest.n8n?.credentials ?? [])];
const required = [
	...metadata,
	// The codex file: n8n reads its categories and search aliases from it.
	'dist/nodes/SourceToDocs/SourceToDocs.node.json',
];
const missing = [...declared, ...required].filter((path) => !files.includes(path));

// The CHANGELOG shipped in the package must have an entry for the version being packed.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const unreleased = !new RegExp(`^## \\[${manifest.version.replace(/\./g, '\\.')}\\]`, 'm').test(
	changelog,
);

if (stray.length > 0 || missing.length > 0 || unreleased) {
	if (unreleased) {
		console.error(
			`CHANGELOG.md has no "## [${manifest.version}]" heading for the version in package.json.`,
		);
	}
	if (stray.length > 0) {
		console.error(
			`The package would ship ${stray.length} file(s) it must not:\n  ${stray.join('\n  ')}`,
		);
	}
	if (missing.length > 0) {
		console.error(
			`The package lacks what package.json "n8n" declares (did you build?):\n  ${missing.join('\n  ')}`,
		);
	}
	process.exit(1);
}

console.log(`Package contents ok: ${files.length} files.`);
