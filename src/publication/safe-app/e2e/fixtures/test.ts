import { test as base, expect } from '@playwright/test';
import { getSafeInfoMockInitScript } from './safe-mock';

/**
 * Playwright test fixture for safe-app e2e.
 *
 * Every test gets a fresh context (and page) with the Safe getSafeInfo mock
 * applied via context.addInitScript BEFORE the first page is created, so the
 * app boots inside a mocked Safe iframe exactly like qa/qa.mjs does.
 *
 * Specs import from this module:
 *   import { test, expect } from '../fixtures/test';
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(getSafeInfoMockInitScript());
    await use(context);
  },
});

export { expect };
