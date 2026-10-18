import { describe, it, expect, vi } from 'vitest';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-confirm-modal';
import type { S2SConfirmModal } from '../../src/components/s2s-confirm-modal';

function dialogText(el: S2SConfirmModal): string {
  return el.shadowRoot?.querySelector('.dialog')?.textContent ?? '';
}

describe('s2s-confirm-modal', () => {
  it('renders nothing when closed', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: false });
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    expect(el.shadowRoot?.querySelector('.dialog')).toBeNull();
  });

  it('renders a blurred full-size overlay with a centered bordered dialog when open', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', {
      open: true,
      headline: 'Reset publication?',
      message: 'This disables the S2S modules and clears the name record.',
      confirmLabel: 'Confirm reset',
      cancelLabel: 'Never mind',
    });

    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    // Full-size, fixed overlay that blurs the page behind it.
    const overlayStyle = getComputedStyle(overlay);
    expect(overlayStyle.position).toBe('fixed');
    expect(overlayStyle.inset).toBe('0px');
    expect(`${overlayStyle.backdropFilter} ${overlayStyle.webkitBackdropFilter}`).toMatch(/blur/);

    // Centered card with border, rounded corners and padding.
    const dialog = el.shadowRoot?.querySelector('.dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    const dialogStyle = getComputedStyle(dialog);
    expect(dialogStyle.borderRadius).not.toBe('0px');
    expect(parseFloat(dialogStyle.padding)).toBeGreaterThan(0);
    expect(parseFloat(dialogStyle.borderTopWidth)).toBeGreaterThan(0);

    // Warning headline + message + confirm/cancel actions.
    expect(dialogText(el)).toContain('Reset publication?');
    expect(dialogText(el)).toContain('This disables the S2S modules and clears the name record.');
    expect(el.shadowRoot?.querySelector('#confirm-ok')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('#confirm-cancel')).toBeTruthy();
  });

  it('confirm button emits a composed s2s-confirm event', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', {
      open: true,
      confirmLabel: 'Confirm reset',
    });
    const spy = vi.fn();
    el.addEventListener('s2s-confirm', spy);

    const ok = el.shadowRoot?.querySelector('#confirm-ok') as HTMLElement;
    ok.click();
    await el.updateComplete;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('cancel button emits a composed s2s-cancel event', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: true });
    const spy = vi.fn();
    el.addEventListener('s2s-cancel', spy);

    const cancel = el.shadowRoot?.querySelector('#confirm-cancel') as HTMLButtonElement;
    cancel.click();
    await el.updateComplete;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop cancels, but clicks inside the dialog do not', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: true });
    const spy = vi.fn();
    el.addEventListener('s2s-cancel', spy);

    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    const dialog = el.shadowRoot?.querySelector('.dialog') as HTMLElement;

    // Click inside the card → no cancel.
    dialog.click();
    await el.updateComplete;
    expect(spy).not.toHaveBeenCalled();

    // Click the backdrop itself → cancel.
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Escape emits s2s-cancel', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: true });
    const spy = vi.fn();
    el.addEventListener('s2s-cancel', spy);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await el.updateComplete;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('busy disables the confirm action', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: true, busy: true });
    const ok = el.shadowRoot?.querySelector('#confirm-ok') as unknown as { disabled: boolean };
    expect(ok.disabled).toBe(true);
  });

  it('removes the Escape listener once closed', async () => {
    const el = await mountLit<S2SConfirmModal>('s2s-confirm-modal', { open: true });
    const spy = vi.fn();
    el.addEventListener('s2s-cancel', spy);

    el.open = false;
    await el.updateComplete;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(spy).not.toHaveBeenCalled();
  });
});
