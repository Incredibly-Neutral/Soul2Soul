import { describe, it, expect, vi } from 'vitest';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-init-progress-modal';
import type { S2SInitProgressModal } from '../../src/components/s2s-init-progress-modal';

function text(el: S2SInitProgressModal): string {
  return el.shadowRoot?.querySelector('.dialog')?.textContent ?? '';
}

describe('s2s-init-progress-modal', () => {
  it('renders nothing when closed', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', { open: false });
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    expect(el.shadowRoot?.querySelector('.dialog')).toBeNull();
  });

  it('renders a blurred full-size overlay with a centered dialog when open', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'detecting',
    });

    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    const overlayStyle = getComputedStyle(overlay);
    expect(overlayStyle.position).toBe('fixed');
    expect(overlayStyle.inset).toBe('0px');
    expect(`${overlayStyle.backdropFilter} ${overlayStyle.webkitBackdropFilter}`).toMatch(/blur/);

    const dialog = el.shadowRoot?.querySelector('.dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(text(el)).toContain('Initializing publication');
  });

  it('shows the checklist with the current proposal active and past ones done', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'awaiting-finalize',
    });

    const steps = el.shadowRoot?.querySelectorAll<HTMLElement>('.step') ?? [];
    expect(steps.length).toBe(3);

    // Create already sent + executed → done (check). Finalize waiting → current
    // (spinner). Config not reached yet → pending (dot).
    expect(steps[0]?.classList.contains('step--done')).toBe(true);
    expect(steps[1]?.classList.contains('step--current')).toBe(true);
    expect(steps[2]?.classList.contains('step--pending')).toBe(true);
    expect(steps[0]?.querySelector('ph-check')).toBeTruthy();
    expect(steps[1]?.querySelector('.step__marker--spinner')).toBeTruthy();

    // No explanatory copy below the checklist — the native Safe queue on this
    // page is the surface that shows the pending transactions.
    expect(text(el)).not.toContain('Waiting for proposal');
    expect(text(el)).not.toContain('queued in the Safe');
  });

  it('marks every step done for phase done', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'done',
    });

    const steps = el.shadowRoot?.querySelectorAll<HTMLElement>('.step') ?? [];
    expect(steps.length).toBe(3);
    expect(steps[0]?.classList.contains('step--done')).toBe(true);
    expect(steps[1]?.classList.contains('step--done')).toBe(true);
    expect(steps[2]?.classList.contains('step--done')).toBe(true);
    expect(text(el)).not.toContain('Publication initialized');
  });

  it('highlights the config step (step 3) as current while the config record is proposed', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'awaiting-config',
    });

    const steps = el.shadowRoot?.querySelectorAll<HTMLElement>('.step') ?? [];
    expect(steps.length).toBe(3);
    expect(steps[0]?.classList.contains('step--done')).toBe(true);
    expect(steps[1]?.classList.contains('step--done')).toBe(true);
    expect(steps[2]?.classList.contains('step--current')).toBe(true);
    expect(steps[2]?.querySelector('.step__marker--spinner')).toBeTruthy();
    expect(text(el)).toContain('Initialize configuration');
  });

  it('renders the host-driven status message under the step list', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'configuring',
      message: 'Building configuration…',
    });

    const message = el.shadowRoot?.querySelector('#init-progress-message');
    expect(message?.textContent).toBe('Building configuration…');
    // Under the checklist, and no error/retry while the step is healthy.
    const steps = el.shadowRoot?.querySelector('.steps');
    expect(steps?.nextElementSibling).toBe(message);
    expect(el.shadowRoot?.querySelector('#init-progress-error')).toBeNull();
    expect(el.shadowRoot?.querySelector('#init-retry')).toBeNull();

    // The waiting copy is a status line, not a link: the modal never renders URLs.
    el.message = 'Configuration proposal sent — execute it in the Safe app to finish.';
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('#init-progress-message')?.textContent).toContain(
      'execute it in the Safe app',
    );
    expect(text(el)).not.toContain('http');
  });

  it('renders the error in the red init-error block and a Retry action that dispatches s2s-init-retry', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'configuring',
      error: 'The Config tab is not available, so the configuration record was not proposed.',
    });

    const error = el.shadowRoot?.querySelector('#init-progress-error') as HTMLElement;
    expect(error).toBeTruthy();
    expect(error.textContent).toContain('Config tab is not available');
    expect(error.getAttribute('role')).toBe('alert');
    const style = getComputedStyle(error);
    expect(style.backgroundColor).toBe('rgb(58, 20, 20)'); // --error-bg
    expect(style.borderTopColor).toBe('rgb(122, 42, 42)'); // --error-border

    const retry = el.shadowRoot?.querySelector('#init-retry') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    expect(retry.textContent?.trim()).toBe('Retry');

    const onRetry = vi.fn();
    document.body.addEventListener('s2s-init-retry', onRetry);
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('s2s-init-retry', onRetry);

    // A retry in flight is driven by the host: clearing the error removes the
    // action while the checklist/message stay.
    el.error = '';
    el.message = 'Building configuration…';
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('#init-progress-error')).toBeNull();
    expect(el.shadowRoot?.querySelector('#init-retry')).toBeNull();
    expect(el.shadowRoot?.querySelectorAll('.step').length).toBe(3);
  });
});
