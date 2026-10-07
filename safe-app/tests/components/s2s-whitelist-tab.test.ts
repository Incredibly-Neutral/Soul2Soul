import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SWhitelistTab } from '../../src/components/s2s-whitelist-tab';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-whitelist-tab';

const AUTHOR_A = '0x1111111111111111111111111111111111111111';
const AUTHOR_B = '0x2222222222222222222222222222222222222222';
const DEV_A = '0x3333333333333333333333333333333333333333';

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

describe('s2s-whitelist-tab', () => {
  let safeIntegration: ReturnType<typeof makeSafeIntegration>;

  beforeEach(() => {
    safeIntegration = makeSafeIntegration();
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

  it('renders whitelisted authors and developers with remove buttons', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A, AUTHOR_B]);
    safeIntegration.getWhitelistedDevs.mockResolvedValue([DEV_A]);

    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() =>
      expect(el.shadowRoot?.textContent).toContain(`Authors (2)`),
    );

    expect(el.shadowRoot?.textContent).toContain(AUTHOR_A);
    expect(el.shadowRoot?.textContent).toContain(AUTHOR_B);
    expect(el.shadowRoot?.textContent).toContain(DEV_A);

    const removeButtons = el.shadowRoot?.querySelectorAll('button[data-address]') ?? [];
    expect(removeButtons).toHaveLength(3);
  });

  it('adds a valid author optimistically and clears the input', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#add-author-input'));

    const input = el.shadowRoot?.querySelector('#add-author-input') as HTMLInputElement;
    input.value = AUTHOR_A;
    (el.shadowRoot?.querySelector('#add-author-btn') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(safeIntegration.whitelistAuthor).toHaveBeenCalledWith(AUTHOR_A),
    );
    await vi.waitFor(() => expect(notificationTexts()).toContain('Author whitelisted!'));
    expect(el.shadowRoot?.textContent).toContain(AUTHOR_A); // optimistic row
    expect(input.value).toBe('');
  });

  it('rejects an invalid address with an error notification and no SDK call', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#add-author-input'));

    const input = el.shadowRoot?.querySelector('#add-author-input') as HTMLInputElement;
    input.value = '0xnotanaddress';
    (el.shadowRoot?.querySelector('#add-author-btn') as HTMLButtonElement).click();
    await el.updateComplete;

    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('Invalid Ethereum address'),
    );
    expect(safeIntegration.whitelistAuthor).not.toHaveBeenCalled();
  });

  it('ignores an empty address (input handler guards before addAuthor)', async () => {
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#add-author-input'));

    (el.shadowRoot?.querySelector('#add-author-btn') as HTMLButtonElement).click();
    await el.updateComplete;

    expect(safeIntegration.whitelistAuthor).not.toHaveBeenCalled();
    expect(notificationTexts()).not.toContain('Address cannot be empty');
  });

  it('rejects a duplicate author', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A]);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#add-author-input'));

    const input = el.shadowRoot?.querySelector('#add-author-input') as HTMLInputElement;
    input.value = AUTHOR_A;
    (el.shadowRoot?.querySelector('#add-author-btn') as HTMLButtonElement).click();
    await el.updateComplete;

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
      await vi.waitFor(() => el.shadowRoot?.querySelector('button[data-address]'));

      (el.shadowRoot?.querySelector('button[data-address]') as HTMLButtonElement).click();
      await el.updateComplete;

      expect(confirmSpy).toHaveBeenCalled();
      expect(safeIntegration.removeWhitelistedAuthor).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('removes an author after confirm() and drops the row optimistically', async () => {
    safeIntegration.getWhitelistedAuthors.mockResolvedValue([AUTHOR_A, AUTHOR_B]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
      await vi.waitFor(() => el.shadowRoot?.querySelector('button[data-address]'));

      // Remove the first author (AUTHOR_A).
      (el.shadowRoot?.querySelector('button[data-address]') as HTMLButtonElement).click();

      await vi.waitFor(() =>
        expect(safeIntegration.removeWhitelistedAuthor).toHaveBeenCalledWith(AUTHOR_A),
      );
      await vi.waitFor(() => expect(notificationTexts()).toContain('Author removed!'));
      expect(el.shadowRoot?.textContent).not.toContain(AUTHOR_A);
      expect(el.shadowRoot?.textContent).toContain(AUTHOR_B);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('reports CAN publish when the address has permission', async () => {
    safeIntegration.canPublish.mockResolvedValue(true);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#check-address'));

    const input = el.shadowRoot?.querySelector('#check-address') as HTMLInputElement;
    input.value = AUTHOR_A;
    (el.shadowRoot?.querySelector('#check-btn') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(safeIntegration.canPublish).toHaveBeenCalledWith(AUTHOR_A),
    );
    await vi.waitFor(() =>
      expect(notificationTexts()).toContain(`${AUTHOR_A} CAN publish`),
    );
  });

  it('reports CANNOT publish when the address lacks permission', async () => {
    safeIntegration.canPublish.mockResolvedValue(false);
    const el = await mountLit<S2SWhitelistTab>('s2s-whitelist-tab', { safeIntegration });
    await vi.waitFor(() => el.shadowRoot?.querySelector('#check-address'));

    const input = el.shadowRoot?.querySelector('#check-address') as HTMLInputElement;
    input.value = DEV_A;
    (el.shadowRoot?.querySelector('#check-btn') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(notificationTexts()).toContain(`${DEV_A} CANNOT publish`),
    );
  });
});
