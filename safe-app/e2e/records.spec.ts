import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * records.spec.ts — the Records tab renders the on-chain Records module table.
 * This Safe reliably has records on Base, so we can assert actual rows here
 * (row count > 0, key/value cells, per-row actions) plus the ENS write-target
 * domain UI. Interaction is UI-only (Edit/Cancel toggles edit mode — no tx).
 */
test.describe('records tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'records-tab');
  });

  test('renders the records table with rows from the on-chain Records module', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-records-tab');
    await expect(
      tab.locator('.section-title').filter({ hasText: 'Records' }),
    ).toBeVisible();

    const rows = tab.locator('.table-row');
    await expect(rows.first()).toBeVisible({ timeout: 120_000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('each record row exposes key/value cells and Edit/Delete actions', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-records-tab');
    const rows = tab.locator('.table-row');
    await expect(rows.first()).toBeVisible({ timeout: 120_000 });

    const first = rows.first();
    // first cell = record key (non-empty), second = value
    await expect(first.locator('.table-cell').nth(0)).not.toBeEmpty();
    await expect(first.locator('.table-cell').nth(1)).toBeVisible();
    await expect(first.getByRole('button', { name: /Edit/ })).toBeVisible();
    await expect(first.getByRole('button', { name: /Delete/ })).toBeVisible();
  });

  test('Edit toggles a row into edit mode and Cancel restores it (UI only)', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-records-tab');
    const rows = tab.locator('.table-row');
    await expect(rows.first()).toBeVisible({ timeout: 120_000 });

    const first = rows.first();
    await first.getByRole('button', { name: /Edit/ }).click();
    await expect(first.locator('input.record-value-input')).toBeVisible();
    await expect(first.getByRole('button', { name: /Save/ })).toBeVisible();

    await first.getByRole('button', { name: /Cancel/ }).click();
    await expect(first.locator('input.record-value-input')).toHaveCount(0);
  });

  test('renders the ENS write-target domain section with its input', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-records-tab');
    await expect(
      tab.locator('.section-title').filter({ hasText: 'ENS write-target' }),
    ).toBeVisible();
    await expect(tab.locator('#domain-input')).toBeVisible();
    await expect(tab.getByRole('button', { name: /Add domain/ })).toBeVisible();
  });
});
