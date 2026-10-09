import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * whitelist.spec.ts — verifies BEHAVIOR of the Whitelists tab: it boots into
 * its two sections (a smoke check that the tab actually mounts and renders,
 * catching silent reactivity/`tabs don't switch` regressions) and that the
 * can-publish check control accepts typed input. Data comes from real RPC on
 * the publication module, so no exact values are asserted. Structural
 * presence-only assertions (sliding-add counts, pill rows, pills-or-empty)
 * were dropped per reviewer guidance: e2e verifies behavior, not that work
 * was done.
 */
test.describe('whitelist tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'whitelist-tab');
  });

  test('renders the Authors and Developers sections', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-whitelist-tab');
    await expect(tab.locator('.section-title').filter({ hasText: 'Authors' })).toBeVisible();
    await expect(tab.locator('.section-title').filter({ hasText: 'Developers' })).toBeVisible();
  });

  test('s2s-check input accepts typed text (read-only UI)', async ({ page }) => {
    const input = page
      .locator('s2s-app')
      .locator('s2s-whitelist-tab')
      .locator('s2s-check')
      .getByRole('textbox');
    await input.fill('0xabc');
    await expect(input).toHaveValue('0xabc');
  });
});
