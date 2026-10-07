import { test, expect } from './fixtures/test';
import { bootApp, tabButton, TABS, collectPageErrors } from './helpers/app';

test.setTimeout(180_000);

/**
 * boot.spec.ts — the app boots inside the mocked Safe iframe, renders its
 * shell with 5 nav tabs, and produces no uncaught page errors.
 * Mirrors what qa/qa.mjs checks for app boot.
 */
test.describe('app boot', () => {
  test('boots inside the mocked Safe iframe and renders the app shell', async ({ page }) => {
    const errors = collectPageErrors(page);
    await bootApp(page);

    await expect(page.locator('s2s-app')).toBeVisible();
    await expect(page.locator('s2s-app').locator('.header')).toBeVisible();

    // The Safe's real modules were detected over real RPC, so no
    // "No S2S modules found" error banner is shown.
    await expect(page.locator('s2s-app').locator('.error-message')).toHaveCount(0);

    // Let the background data fetches settle before checking for errors.
    await page.waitForTimeout(5_000);
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('renders all 5 nav tabs enabled', async ({ page }) => {
    const errors = collectPageErrors(page);
    await bootApp(page);

    for (const { id } of TABS) {
      const btn = tabButton(page, id);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }

    await page.waitForTimeout(5_000);
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
