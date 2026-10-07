import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * deals.spec.ts — the Deals tab renders its toolbar, the Active Deals section
 * and the Check Deal form. Deals/offers come from real RPC on the publication
 * module, so assert STRUCTURE (sections, forms, rows-or-empty) not values.
 */
test.describe('deals tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'deals-tab');
  });

  test('renders the toolbar, Active Deals section and Check Deal form', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-deals-tab');
    await expect(tab.getByRole('button', { name: /Bulk Render/ })).toBeVisible();
    await expect(
      tab.locator('.section-title').filter({ hasText: 'Active Deals' }),
    ).toBeVisible();
    await expect(
      tab.locator('.section-title').filter({ hasText: 'Check Deal Status' }),
    ).toBeVisible();
    await expect(tab.locator('#check-genesis')).toBeVisible();
    await expect(tab.locator('#check-deal-btn')).toBeVisible();
  });

  test('offers/deals tables render rows with data-genesis, or the empty state', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-deals-tab');
    const rows = tab.locator('.table-row');
    const empty = tab.locator('.empty-state');

    // The deals tab starts in a loading state while it fetches over real RPC;
    // afterwards it must render either table rows or an empty state.
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

  test('check-genesis input accepts typed text (read-only UI)', async ({ page }) => {
    const input = page
      .locator('s2s-app')
      .locator('s2s-deals-tab')
      .locator('#check-genesis');
    await input.fill('0xdeadbeef');
    await expect(input).toHaveValue('0xdeadbeef');
  });
});
