import { describe, it, expect } from 'vitest';
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
});
