import { test, expect } from './fixtures/test';
import { bootApp, openTab } from './helpers/app';

test.setTimeout(180_000);

/**
 * website-tree.spec.ts — the Website Tree tab renders its toolbar (Sync /
 * Reset) and then either the decoded IPFS tree nodes or the no-root
 * error/loading state (depends on real ENS/IPFS state for this Safe).
 * Interaction is read-only UI: the controls are present and actionable.
 */
test.describe('website-tree tab', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await openTab(page, 'website-tree-tab');
  });

  test('renders the toolbar with Sync and Reset controls', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-website-tree-tab');
    await expect(
      tab.locator('.section-title').filter({ hasText: 'Website Tree' }),
    ).toBeVisible();

    const sync = tab.locator('#sync-btn');
    const reset = tab.locator('#reset-btn');
    await expect(sync).toBeVisible();
    await expect(reset).toBeVisible();

    // Structural/UI-state assertion: both controls settle into an actionable
    // (enabled) state once any in-flight sync finishes.
    await expect(sync).toBeEnabled({ timeout: 60_000 });
    await expect(reset).toBeEnabled({ timeout: 60_000 });
  });

  test('renders tree nodes, or the no-root error/loading state', async ({ page }) => {
    const tab = page.locator('s2s-app').locator('s2s-website-tree-tab');
    const nodes = tab.locator('.tree-root, .tree-dir, .tree-file');
    const state = tab.locator('.error, .loading');

    await expect
      .poll(
        async () =>
          (await nodes.count()) > 0 || (await state.count()) > 0,
        { timeout: 120_000 },
      )
      .toBe(true);

    if ((await nodes.count()) > 0) {
      await expect(tab.locator('.stats')).toBeVisible();
    }
  });
});
