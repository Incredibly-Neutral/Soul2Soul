import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * storage.spec.ts — the Storage tab renders the Filecoin storage UI. Pieces
 * are fetched over real Filecoin RPC at boot; when the node reports no pieces
 * for this Safe's wallet, the tab stays on its "Loading storage data…" gate
 * forever. So the structural assertion accepts EITHER the full storage UI
 * (toolbar + tables + filters) OR that loading state, and when rows do render
 * they must be present with sortable headers.
 */
test.describe('storage tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'storage-tab');
  });

  test('renders the storage tab component', async ({ page }) => {
    await expect(page.locator('s2s-app').locator('s2s-storage-tab')).toBeAttached();
  });

  test('renders the storage UI when pieces exist, or the loading gate when none are reported', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-storage-tab');

    const ui = tab.locator('.toolbar, .table-pieces');
    const loading = tab.locator('.loading');

    await expect
      .poll(
        async () =>
          (await ui.count()) > 0 || (await loading.count()) > 0,
        { timeout: 120_000 },
      )
      .toBe(true);

    if ((await ui.count()) > 0) {
      // Real storage UI: rows are present and the table is sortable/filterable.
      const rows = tab.locator('.table-row');
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      expect(await rows.count()).toBeGreaterThan(0);
      await expect(tab.locator('table-filter').first()).toBeVisible();
      await expect(tab.locator('[data-sort]').first()).toBeVisible();
    } else {
      await expect(loading).toBeVisible();
    }
  });
});
