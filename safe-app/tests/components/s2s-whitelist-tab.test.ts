import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SWhitelistTab } from '../../src/components/s2s-whitelist-tab';
import type { S2SCheck } from '../../src/components/s2s-check';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-whitelist-tab';

const AUTHOR_A = '0x1111111111111111111111111111111111111111';
const AUTHOR_B = '0x2222222222222222222222222222222222222222';
const DEV_A = '0x3333333333333333333333333333333333333333';

// copy-hash truncates long values to first4...last4 only on wide viewports.
// Pin innerWidth above breakpoints.md so truncation is deterministic, and mock
// the Clipboard API so copy-button interactions never hit the real clipboard.
Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });

/**
 * s2s-whitelist-tab only uses SafeIntegration as a prop type, so we drive it
 * with a hand-rolled mock object (no Safe SDK, no iframe, no wallet).
 */
function makeSafeIntegration() {
  return {
    getWhitelistedAuthors: vi.fn(async (): Promise<string[]> => []),
    getWhitelistedDevs: vi.fn(async (): Promise<string[]> => []),
    whitelistAuthor: vi.fn(async (_a: string): Promise<void> => {}),
    removeWhitelistedAuthor: vi.fn(async (_a: string): Promise<void> => {}),
    whitelistDev: vi.fn(async (_d: string): Promise<void> => {}),
    removeWhitelistedDev: vi.fn(async (_d: string): Promise<void> => {}),
    canPublish: vi.fn(async (_a: string): Promise<boolean> => true),
  };
}

function notificationTexts(): string {
  return document.body.textContent ?? '';
}

// ---------------------------------------------------------------------------
// New-DOM helpers — the whitelist is now a pill row per section, driven by the
// slide-open <s2s-sliding-add-button> (its input lives in a nested shadow root)
// and <copy-hash> (truncated display + copy button).
// ---------------------------------------------------------------------------

/** The two .section blocks (0 = Authors, 1 = Developers). */
function sections(el: S2SWhitelistTab): HTMLElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.section')];
}

/** The <s2s-sliding-add-button> host inside a section's shadow. */
function addHost(section: HTMLElement): HTMLElement & { open: boolean } {
  const host = section.querySelector('s2s-sliding-add-button');
  if (!host) throw new Error('s2s-sliding-add-button not found');
  return host as HTMLElement & { open: boolean };
}

/** The Add button inside the sliding-add-button's shadow root. */
function addButton(section: HTMLElement): HTMLButtonElement {
  const btn = addHost(section).shadowRoot!.querySelector<HTMLButtonElement>('#add-btn');
  if (!btn) throw new Error('Add button not found');
  return btn;
}

/** The slide-open input inside the sliding-add-button's shadow root. */
function addInput(section: HTMLElement): HTMLInputElement {
  const input = addHost(section).shadowRoot!.querySelector<HTMLInputElement>('.add__input');
  if (!input) throw new Error('add input not found');
  return input;
}

/** Open the slide-open input (first click on Add). No-op if already open. */
async function openAddInput(section: HTMLElement): Promise<void> {
  await vi.waitFor(() => addHost(section).shadowRoot?.querySelector('#add-btn'));
  if (!addHost(section).open) addButton(section).click();
}

/** Open the add input and set its value (replaces the old #add-author-input setter). */
async function setAddInput(section: HTMLElement, value: string): Promise<void> {
  await openAddInput(section);
  await vi.waitFor(() => addHost(section).shadowRoot?.querySelector('.add__input'));
  addInput(section).value = value;
}

/** Submit the open add input (Enter — the slide-open submit path). */
async function submitAddInput(section: HTMLElement): Promise<void> {
  await vi.waitFor(() => addHost(section).shadowRoot?.querySelector('.add__input'));
  addInput(section).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** The full (untruncated) addresses rendered as pills in a section. */
function pillValues(section: HTMLElement): string[] {
  return [...section.querySelectorAll<HTMLElement>('copy-hash')].map(
    (c) => (c as unknown as { value: string }).value,
  );
}

describe('s2s-whitelist-tab', () => {
  let safeIntegration: ReturnType<typeof makeSafeIntegration>;

  beforeEach(() => {
    safeIntegration = makeSafeIntegration();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
      writable: true,
    });
  });

  it('shows the loading state until the whitelists resolve, then empty states', async () => {
    let resolveAuthors!: (v: string[]) => void;
    let resolveDevs!: (v: string[]) => void;
    safeIntegration.getWhitelistedAuthors.mockReturnValue(
      new Promise((r) => (resolveAuthors = r)),
    );
    safeIntegration.getWhitelistedDevs.mockReturnValue(new Promise((r) => (resolveDevs = r)));

    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    expect(el.shadowRoot?.textContent).toContain('Loading whitelists...');

    resolveAuthors([]);
    resolveDevs([]);
    await vi.waitFor(() =>
      expect(el.shadowRoot?.textContent).toContain('No authors whitelisted yet'),
    );
    expect(el.shadowRoot?.textContent).toContain('No developers whitelisted yet');
  });

  it('adds a valid author via the sliding-add control, optimistically', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('.section'));
    const authors = sections(el)[0];

    await setAddInput(authors, AUTHOR_A);
    await submitAddInput(authors);

    await vi.waitFor(() =>
      expect(safeIntegration.whitelistAuthor).toHaveBeenCalledWith(AUTHOR_A),
    );
    await vi.waitFor(() => expect(notificationTexts()).toContain('Author whitelisted!'));
    await vi.waitFor(() => expect(pillValues(authors)).toContain(AUTHOR_A)); // optimistic pill
    expect(addInput(authors).value).toBe(''); // sliding-add clears after submit
  });

  it('rejects an invalid address with an error notification and no SDK call', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('.section'));
    const authors = sections(el)[0];

    await setAddInput(authors, '0xnotanaddress');
    await submitAddInput(authors);

    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('Invalid Ethereum address'),
    );
    expect(safeIntegration.whitelistAuthor).not.toHaveBeenCalled();
  });

  it('ignores an empty address (sliding-add never dispatches, no SDK call)', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('.section'));
    const authors = sections(el)[0];

    await setAddInput(authors, '   ');
    await submitAddInput(authors);

    expect(safeIntegration.whitelistAuthor).not.toHaveBeenCalled();
    expect(notificationTexts()).not.toContain('Address cannot be empty');
  });

  it('rejects a duplicate author', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A]);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('.section'));
    const authors = sections(el)[0];

    await setAddInput(authors, AUTHOR_A);
    await submitAddInput(authors);

    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('Author already whitelisted'),
    );
    expect(safeIntegration.whitelistAuthor).not.toHaveBeenCalled();
  });

  it('skips removal when confirm() is dismissed', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
      await vi.waitFor(() => sections(el)[0].querySelector('.alias-pill__remove'));

      (sections(el)[0].querySelector('.alias-pill__remove') as HTMLButtonElement).click();
      await el.updateComplete;

      expect(confirmSpy).toHaveBeenCalled();
      expect(safeIntegration.removeWhitelistedAuthor).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('removes an author after confirm() and drops the pill optimistically', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A, AUTHOR_B]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
      await vi.waitFor(() => sections(el)[0].querySelector('.alias-pill__remove'));

      // Remove the first author (AUTHOR_A).
      (sections(el)[0].querySelector('.alias-pill__remove') as HTMLButtonElement).click();

      await vi.waitFor(() =>
        expect(safeIntegration.removeWhitelistedAuthor).toHaveBeenCalledWith(AUTHOR_A),
      );
      await vi.waitFor(() => expect(notificationTexts()).toContain('Author removed!'));
      await vi.waitFor(() =>
        expect(pillValues(sections(el)[0])).not.toContain(AUTHOR_A),
      );
      expect(pillValues(sections(el)[0])).toContain(AUTHOR_B);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('reports CAN publish when the address has permission', async () => {
    safeIntegration.canPublish.mockResolvedValue(true);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    const check = await vi.waitFor(() => {
      const host = el.shadowRoot?.querySelector('s2s-check') as S2SCheck | null;
      if (!host) throw new Error('s2s-check not rendered');
      return host;
    });

    // Drive the flow through <s2s-check>: type → click check → handler → canPublish.
    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = AUTHOR_A;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(safeIntegration.canPublish).toHaveBeenCalledWith(AUTHOR_A),
    );
    await vi.waitFor(() => expect(check.result).toBe('pass'));
    expect(check.message).toBe('can publish');
  });

  it('reports CANNOT publish when the address lacks permission', async () => {
    safeIntegration.canPublish.mockResolvedValue(false);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    const check = await vi.waitFor(() => {
      const host = el.shadowRoot?.querySelector('s2s-check') as S2SCheck | null;
      if (!host) throw new Error('s2s-check not rendered');
      return host;
    });

    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = DEV_A;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(safeIntegration.canPublish).toHaveBeenCalledWith(DEV_A),
    );
    await vi.waitFor(() => expect(check.result).toBe('fail'));
    expect(check.message).toBe('cannot publish');
  });

  it('flags an invalid address as an error result without calling canPublish', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    const check = await vi.waitFor(() => {
      const host = el.shadowRoot?.querySelector('s2s-check') as S2SCheck | null;
      if (!host) throw new Error('s2s-check not rendered');
      return host;
    });

    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = '0xnotanaddress';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(check.result).toBe('error'));
    expect(check.message).toBe('invalid address');
    expect(safeIntegration.canPublish).not.toHaveBeenCalled();
  });
});
