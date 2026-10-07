import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * whitelist.spec.ts — the Whitelists tab renders its Authors + Developers
 * sections and exposes the read/UI surface. Data comes from real RPC on the
 * publication module, so we assert STRUCTURE (sections, forms, rows-or-empty)
 * rather than exact values.
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

  test('renders the add/check forms (address inputs + buttons)', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-whitelist-tab');
    await expect(tab.locator('#add-author-input')).toBeVisible();
    await expect(tab.locator('#add-author-btn')).toBeVisible();
    await expect(tab.locator('#add-dev-input')).toBeVisible();
    await expect(tab.locator('#add-dev-btn')).toBeVisible();
    await expect(tab.locator('#check-address')).toBeVisible();
  });

  test('author table renders rows with data-address, or the empty state', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-whitelist-tab');
    const rows = tab.locator('.table-row');
    const empty = tab.locator('.empty-state');

    // Real RPC may report zero whitelisted authors — accept rows or the empty
    // state as a valid structure, but require one of them to have rendered.
    await expect
      .poll(
        async () =>
          (await rows.count()) > 0 || (await empty.count()) > 0,
        { timeout: 120_000 },
      )
      .toBe(true);

    if ((await rows.count()) > 0) {
      await expect(rows.first()).toHaveAttribute('data-address', /.+/);
    }
  });

  test('check-address input accepts typed text (read-only UI)', async ({ page }) => {
    const input = page
      .locator('s2s-app')
      .locator('s2s-whitelist-tab')
      .locator('#check-address');
    await input.fill('0xabc');
    await expect(input).toHaveValue('0xabc');
  });
});
