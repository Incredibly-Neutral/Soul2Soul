import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyString } from '../../src/components/copy-string';
import { mountLit } from '../helpers/mount';
import '../../src/components/copy-string';

describe('copy-string', () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    writeText.mockReset();
    // The headless browser does not grant the async Clipboard API, so stub it.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  it('renders the value as text', async () => {
    const el = await mountLit<CopyString>('copy-string', { value: 'bafybeihash123' });
    expect(el.shadowRoot?.querySelector('.text')?.textContent?.trim()).toBe('bafybeihash123');
  });

  it('copies the value to the clipboard and shows the copied state', async () => {
    const el = await mountLit<CopyString>('copy-string', { value: 'abc123' });
    const btn = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.classList.contains('copied')).toBe(false);

    btn.click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('abc123'));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true),
    );
  });

  it('falls back to the light-DOM text content when no value prop is set', async () => {
    const el = document.createElement('copy-string') as CopyString;
    el.textContent = '0x0123456789abcdef';
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.value).toBe('0x0123456789abcdef');
  });

  it('resets the copied indicator after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const el = await mountLit<CopyString>('copy-string', { value: 'reset-me' });
      (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
      // copy() completes on microtasks (not timers), so flush them.
      await el.updateComplete;
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true);

      vi.advanceTimersByTime(1600);
      await el.updateComplete;
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
