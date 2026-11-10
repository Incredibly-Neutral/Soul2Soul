import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from '../../../vitest.config.base';

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        // Resolve the shared package to its TypeScript source, like neutralpress
        // and safe-app: the package entry is the gitignored `dist/index.js`, so
        // without this a test run silently depends on whatever build happens to
        // be lying around (and fails outright when none has been built).
        '@s2s/soul2soul-shared': fileURLToPath(new URL('../../shared/src', import.meta.url)),
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      root: '.',
    },
  }),
);
