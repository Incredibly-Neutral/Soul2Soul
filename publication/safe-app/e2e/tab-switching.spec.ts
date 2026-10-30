import { test, expect } from './fixtures/test';
import { bootApp, openTab, activeTab, activeTabComponent, TABS } from './helpers/app';

test.setTimeout(180_000);

/**
 * tab-switching.spec.ts — clicking each nav tab flips the `active` class to
 * that tab AND swaps the rendered component inside #tab-content.
 * Extends qa/qa.mjs's per-tab click checks into a Playwright spec.
 */
test.describe('tab switching', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  for (const { id, tag } of TABS) {
    test(`clicking ${id} activates it and swaps in ${tag}`, async ({ page }) => {
      await openTab(page, id);

      await expect(activeTab(page)).toHaveId(id);
      await expect(activeTabComponent(page)).toHaveJSProperty('tagName', tag);

      // Only the clicked tab is active.
      await expect(
        page.locator('s2s-app').locator('.tab.active'),
      ).toHaveCount(1);
    });
  }
});
