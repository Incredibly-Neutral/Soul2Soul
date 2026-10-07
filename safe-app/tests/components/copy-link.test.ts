import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyLink } from '../../src/components/copy-link';
import { mountLit } from '../helpers/mount';
import '../../src/components/copy-link';

describe('copy-link', () => {
  const writeText = vi.fn(async () => {});
  const open = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    open.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'open', {
      value: open,
      configurable: true,
      writable: true,
    });
  });

  it('renders a labelled anchor pointing at the value', async () => {
    const el = await mountLit<CopyLink>('copy-link', {
      value: '0x1234567890abcdef',
      label: 'my-module',
    });
    const a = el.shadowRoot?.querySelector('a') as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('0x1234567890abcdef');
    expect(a.textContent?.trim()).toBe('my-module');
  });

  it('copies the value on copy-button click', async () => {
    const el = await mountLit<CopyLink>('copy-link', { value: '0xc0ffee', label: 'x' });
    (el.shadowRoot?.querySelector('button.btn-copy') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('0xc0ffee'));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button.btn-copy')?.classList.contains('copied')).toBe(
        true,
      ),
    );
  });

  it('opens the address on basescan via window.open', async () => {
    const el = await mountLit<CopyLink>('copy-link', { value: '0xaddress1234', label: 'x' });
    (el.shadowRoot?.querySelector('button.btn-open') as HTMLButtonElement).click();

    expect(open).toHaveBeenCalledWith(
      'https://basescan.org/address/0xaddress1234',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('reflects the used attribute when set', async () => {
    const el = await mountLit<CopyLink>('copy-link', { value: '0xabc', label: 'x', used: true });
    expect(el.hasAttribute('used')).toBe(true);
  });
});
