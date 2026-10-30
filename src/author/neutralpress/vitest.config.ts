import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from '../../../vitest.config.base';

export default mergeConfig(
	base,
	defineConfig({
		resolve: {
			alias: {
				// Obsidian has no Node entrypoint — tests run headless against a stub.
				obsidian: fileURLToPath(new URL('./test/mocks/obsidian.ts', import.meta.url)),
				// electron ships a CJS path-string export; tests only ever need the
				// type stub (src/content/images.ts imports `App` from "electron").
				electron: fileURLToPath(new URL('./test/mocks/electron.ts', import.meta.url)),
				// Resolve the shared package to its TS source (same as safe-app): the
				// built CJS dist does `require('multiformats/cid')`, which Node's
				// require-condition resolver rejects (export has no `require` entry).
				'@s2s/soul2soul-shared': fileURLToPath(new URL('../../shared/src', import.meta.url)),
			},
		},
		test: {
			include: ['test/**/*.test.ts'],
			root: '.',
			setupFiles: ['./vitest.setup.ts'],
		},
	}),
);
