import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Playwright e2e for safe-app.
 *
 * - testDir: e2e/ (specs are authored by the e2e worker; this repo only ships
 *   the fixtures scaffold under e2e/fixtures/).
 * - Single chromium project.
 * - webServer builds once (`pnpm build` — which itself gates on the vitest
 *   unit + component suite) then serves dist/ via `vite preview --port 4174
 *   --no-open`. `--no-open` is mandatory: vite.config.ts sets preview.open:
 *   true, so without it the preview would try to open a browser headlessly.
 * - reuseExistingServer: true lets the runner attach to an already-running
 *   preview (e.g. a `pnpm qa` server) instead of rebuilding.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${PORT} --no-open`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
