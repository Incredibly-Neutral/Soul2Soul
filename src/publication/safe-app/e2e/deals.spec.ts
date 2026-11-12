import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * deals.spec.ts — the Agreements tab renders its toolbar and the Active
 * Agreements section. Offers/agreements come from real RPC on the publication
 * module, so assert STRUCTURE (sections, forms, rows-or-empty) not values.
 * The filename, the deals-tab id and the s2s-deals-tab element keep the older
 * word.
 */
test.describe('agreements tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'deals-tab');
  });

  test('renders the toolbar and Active Agreements section', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-deals-tab');
    await expect(tab.getByRole('button', { name: /Bulk Render/ })).toBeVisible();
    await expect(
      tab.locator('.section-title').filter({ hasText: 'Active Agreements' }),
    ).toBeVisible();
    await expect(tab.locator('s2s-check')).toBeVisible();
  });

  test('agreements/offers tables render rows with data-genesis, or the empty state', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-deals-tab');
    const rows = tab.locator('.table-row');
    const empty = tab.locator('.empty-state');

    // The agreements tab starts in a loading state while it fetches over real
    // RPC; afterwards it must render either table rows or an empty state.
    await expect
      .poll(
        async () =>
          (await rows.count()) > 0 || (await empty.count()) > 0,
        { timeout: 120_000 },
      )
      .toBe(true);

    if ((await rows.count()) > 0) {
      await expect(rows.first()).toHaveAttribute('data-genesis', /.+/);
    }
  });

  test('s2s-check input accepts typed text (read-only UI)', async ({ page }) => {
    const input = page
      .locator('s2s-app')
      .locator('s2s-deals-tab')
      .locator('s2s-check')
      .getByRole('textbox');
    await input.fill('0xdeadbeef');
    await expect(input).toHaveValue('0xdeadbeef');
  });
});
