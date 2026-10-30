import { defineConfig, mergeConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { resolve } from 'path';
import path from 'path';
import { fileURLToPath } from 'url';
import base from '../../vitest.config.base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '.');

/**
 * Vitest configuration for safe-app.
 *
 * Two projects (run together by `pnpm test`, individually via
 * `--project unit|component`):
 *
 *  - unit      - node-env unit tests under tests/ (all .test.ts)
 *  - component - browser component tests under tests/components/, via
 *                @vitest/browser with the PLAYWRIGHT provider (the playwright
 *                browsers are already installed for qa/e2e).
 *
 * Vite-level options (envDir + resolve.alias) mirror vite.config.ts so
 * component tests can resolve the app's @/..., @s2s/soul2soul-shared subpaths,
 * and the filecoin-pin browser shim exactly like the production build.
 */
export default mergeConfig(
  base,
  defineConfig({
    // Load ../../.env (monorepo root) so VITE_* vars are exposed via
    // import.meta.env in both node and browser test runs.
    envDir: resolve(appRoot, '../..'),

    resolve: {
      alias: [
        { find: '@', replacement: resolve(appRoot, 'src') },
        { find: '@/components', replacement: resolve(appRoot, 'src/components') },
        { find: '@/types', replacement: resolve(appRoot, 'src/types') },
        { find: '@/utils', replacement: resolve(appRoot, 'src/utils') },
        { find: '@s2s/soul2soul-shared', replacement: resolve(appRoot, '../../shared/src') },
        {
          find: 'filecoin-pin/dist/core/unixfs/browser.js',
          replacement: resolve(appRoot, '../../node_modules/filecoin-pin/dist/core/unixfs/browser.js'),
        },
      ],
    },

    test: {
      root: '.',

      // e2e/ and qa/ are never included by the project `include` patterns
      // below; list them explicitly so nothing crawls into Playwright/QA dirs.
      exclude: ['e2e/**', 'qa/**', 'node_modules/**', 'dist/**'],

      projects: [
        {
          // inherit root + base (environment: node, pool: forks)
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
            include: ['tests/**/*.test.ts'],
            exclude: ['tests/components/**'],
            setupFiles: ['./vitest.setup.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'component',
            include: ['tests/components/**/*.test.ts'],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              instances: [{ browser: 'chromium' }],
            },
            setupFiles: ['./tests/helpers/setup-browser.ts'],
          },
        },
      ],
    },
  }),
);
