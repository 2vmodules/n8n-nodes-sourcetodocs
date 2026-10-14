import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		testTimeout: 30_000,
		pool: 'forks',
		// Coverage of the compiled CommonJS in node-dist/, mapped back to the .ts sources by the
		// source maps tsc writes next to it. Run with `npm run coverage`.
		coverage: {
			provider: 'v8',
			include: ['node-dist/**/*.js'],
			reporter: ['text', 'json-summary'],
			reportsDirectory: './coverage',
		},
	},
});
