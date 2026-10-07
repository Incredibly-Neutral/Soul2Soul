import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyHash } from '../../src/components/copy-hash';
import { mountLit } from '../helpers/mount';
import '../../src/components/copy-hash';

const LONG_VALUE = 'bafybeigdyrzt5fshlp2tdzwf5pbqmxwzfh2x7m7k6g6qk6e6qk6e6qk6e';

describe('copy-hash', () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    // Wide viewport → long hashes shorten to first4...last4.
    Object.defineProperty(window, 'innerWidth', {
      value: 1280,
      configurable: true,
      writable: true,
    });
  });

  it('renders short values verbatim and long values truncated to first4...last4', async () => {
    const el = await mountLit<CopyHash>('copy-hash', { value: '0xab' });
    expect(el.shadowRoot?.querySelector('.text')?.textContent?.trim()).toBe('0xab');

    el.value = LONG_VALUE;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.text')?.textContent?.trim()).toBe(
      `${LONG_VALUE.slice(0, 4)}...${LONG_VALUE.slice(-4)}`,
    );
  });

  it('copies the full (untruncated) value via the async Clipboard API', async () => {
    const el = await mountLit<CopyHash>('copy-hash', { value: LONG_VALUE });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG_VALUE));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true),
    );
  });

  it('falls back to document.execCommand when the Clipboard API rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('permission denied'));
    const execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    try {
      const el = await mountLit<CopyHash>('copy-hash', { value: '0xlegacy' });
      (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();

      await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      await vi.waitFor(() =>
        expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true),
      );
    } finally {
      execCommand.mockRestore();
    }
  });
});
