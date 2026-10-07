import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CopyModule } from '../../src/components/copy-module';
import { mountLit } from '../helpers/mount';
import '../../src/components/copy-module';

describe('copy-module', () => {
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

  it('renders the label and copies the module address', async () => {
    const el = await mountLit<CopyModule>('copy-module', {
      value: '0xmodule111111',
      label: 'Publication Module',
    });
    expect(el.shadowRoot?.textContent).toContain('Publication Module');

    (el.shadowRoot?.querySelector('button.btn-copy') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('0xmodule111111'));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button.btn-copy')?.classList.contains('copied')).toBe(
        true,
      ),
    );
  });

  it('falls back to document.execCommand when the Clipboard API rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    try {
      const el = await mountLit<CopyModule>('copy-module', { value: '0xlegacy', label: 'x' });
      (el.shadowRoot?.querySelector('button.btn-copy') as HTMLButtonElement).click();

      await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      await vi.waitFor(() =>
        expect(
          el.shadowRoot?.querySelector('button.btn-copy')?.classList.contains('copied'),
        ).toBe(true),
      );
    } finally {
      execCommand.mockRestore();
    }
  });

  it('opens the module address on basescan', async () => {
    const el = await mountLit<CopyModule>('copy-module', { value: '0xmodule222222', label: 'x' });
    (el.shadowRoot?.querySelector('button.btn-open') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(
      'https://basescan.org/address/0xmodule222222',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
