import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyContentId } from '../../src/components/copy-content-id';
import { mountLit } from '../helpers/mount';
import '../../src/components/copy-content-id';

describe('copy-content-id', () => {
  let execCommand: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // copy-content-id deliberately uses document.execCommand (the async
    // Clipboard API is blocked in the Safe iframe), so stub it to succeed.
    execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(true);
  });

  it('renders the display value with the full value as the title', async () => {
    const el = await mountLit<CopyContentId>('copy-content-id', {
      value: 'bafybeifullcid1234567890',
      display: 'cid-short',
    });
    const text = el.shadowRoot?.querySelector('.text') as HTMLElement;
    expect(text.textContent?.trim()).toBe('cid-short');
    expect(text.getAttribute('title')).toBe('bafybeifullcid1234567890');
  });

  it('defaults display to the value when no display is provided', async () => {
    const el = await mountLit<CopyContentId>('copy-content-id', { value: 'abc123' });
    expect(el.shadowRoot?.querySelector('.text')?.textContent?.trim()).toBe('abc123');
  });

  it('copies the full value via execCommand and shows the copied state', async () => {
    const el = await mountLit<CopyContentId>('copy-content-id', {
      value: 'bafybeicopythis000000',
    });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true),
    );
  });

  it('does not enter the copied state when execCommand fails', async () => {
    execCommand.mockReturnValue(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const el = await mountLit<CopyContentId>('copy-content-id', { value: 'x123' });
      (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
