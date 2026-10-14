import { defineConfig } from 'vitest/config';

// The root suite is the plain-function layer. `test-engine/` is its own package, with its own
// pinned n8n and its own vitest: see test-engine/package.json.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
	},
});
