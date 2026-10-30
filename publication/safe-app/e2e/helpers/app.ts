import { expect, type Page, type Locator } from '../fixtures/test';

/**
 * Shared helpers for the safe-app e2e specs.
 *
 * The app is a lit-element custom element: the whole UI lives inside shadow
 * roots. Playwright locators pierce open shadow DOM automatically when you
 * chain them (e.g. `page.locator('s2s-app').locator('.tab')`), so every helper
 * here is built from chained locators rather than `>>>` (which does not pierce
 * in this Playwright version).
 *
 * All specs hit REAL RPC on Base (module detection + records/deals/whitelist
 * reads) through the Safe mock, so helpers use generous timeouts and poll for
 * structure rather than exact data.
 */

/** The 5 nav tabs and the component each renders when active. */
export const TABS = [
  { id: 'deals-tab', tag: 'S2S-DEALS-TAB' },
  { id: 'whitelist-tab', tag: 'S2S-WHITELIST-TAB' },
  { id: 'records-tab', tag: 'S2S-RECORDS-TAB' },
  { id: 'storage-tab', tag: 'S2S-STORAGE-TAB' },
  { id: 'website-tree-tab', tag: 'S2S-WEBSITE-TREE-TAB' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/**
 * Load the app and wait until the mocked-Safe handshake resolves and all 5
 * nav tabs render (module detection runs against real RPC, so be generous).
 */
export async function bootApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('s2s-app')).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('s2s-app').locator('.tab')).toHaveCount(5, {
    timeout: 120_000,
  });
}

/** Locator for a nav tab button. */
export function tabButton(page: Page, id: TabId): Locator {
  return page.locator('s2s-app').locator(`#${id}`);
}

/** Locator for whichever nav tab currently has the `active` class. */
export function activeTab(page: Page): Locator {
  return page.locator('s2s-app').locator('.tab.active');
}

/** Locator for the tab-content container inside the app shell. */
export function tabContent(page: Page): Locator {
  return page.locator('s2s-app').locator('#tab-content');
}

/** Locator for the active tab's rendered component (child of #tab-content). */
export function activeTabComponent(page: Page): Locator {
  return tabContent(page).locator(':scope > *').first();
}

/**
 * Click a tab and wait until it becomes active AND its component has swapped
 * in. The component swap is async (module-gated renders), so poll the tag.
 */
export async function openTab(page: Page, id: TabId): Promise<void> {
  await tabButton(page, id).click();
  await expect(activeTab(page)).toHaveId(id, { timeout: 30_000 });
  const tag = TABS.find((t) => t.id === id)!.tag;
  await expect(activeTabComponent(page)).toHaveJSProperty('tagName', tag, {
    timeout: 60_000,
  });
}

/** Start collecting uncaught page errors; return the accumulated list. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
