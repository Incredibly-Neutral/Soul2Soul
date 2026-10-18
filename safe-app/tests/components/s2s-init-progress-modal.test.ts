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
      proposals: ['https://app.safe.global/transactions/queue?safe=8453:0xAbC'],
      name: 'my-publication',
    });

    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    const overlayStyle = getComputedStyle(overlay);
    expect(overlayStyle.position).toBe('fixed');
    expect(overlayStyle.inset).toBe('0px');
    expect(`${overlayStyle.backdropFilter} ${overlayStyle.webkitBackdropFilter}`).toMatch(/blur/);

    const dialog = el.shadowRoot?.querySelector('.dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(text(el)).toContain('Initializing publication — my-publication');
  });

  it('shows the checklist with the current proposal active and past ones done', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'awaiting-enable',
    });

    const steps = el.shadowRoot?.querySelectorAll<HTMLElement>('.step') ?? [];
    expect(steps.length).toBe(3);

    // Create already sent + executed → done (check). Enable waiting → current
    // (spinner). Name → pending (dot).
    expect(steps[0]?.classList.contains('step--done')).toBe(true);
    expect(steps[1]?.classList.contains('step--current')).toBe(true);
    expect(steps[2]?.classList.contains('step--pending')).toBe(true);
    expect(steps[0]?.querySelector('ph-check')).toBeTruthy();
    expect(steps[1]?.querySelector('.step__marker--spinner')).toBeTruthy();
    expect(steps[2]?.querySelector('.step__marker--dot')).toBeTruthy();

    // Phase label rendered.
    expect(text(el)).toContain('Waiting for proposal 2 (enable modules) to be executed…');
  });

  it('renders each proposed Safe queue link in order', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'awaiting-name',
      proposals: [
        'https://app.safe.global/transactions/queue?safe=8453:0xAbC&id=1',
        'https://app.safe.global/transactions/queue?safe=8453:0xAbC&id=2',
        'https://app.safe.global/transactions/queue?safe=8453:0xAbC&id=3',
      ],
    });

    const links = el.shadowRoot?.querySelectorAll<HTMLAnchorElement>('.proposal a') ?? [];
    expect(links.length).toBe(3);
    expect(links[0]?.getAttribute('href')).toContain('id=1');
    expect(links[1]?.getAttribute('href')).toContain('id=2');
    expect(links[2]?.getAttribute('href')).toContain('id=3');
    expect(text(el)).toContain('Proposal 1:');
    expect(text(el)).toContain('Proposal 3:');
  });

  it('marks every step done and shows the completion label for phase done', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'done',
    });

    const steps = el.shadowRoot?.querySelectorAll<HTMLElement>('.step') ?? [];
    expect(steps[0]?.classList.contains('step--done')).toBe(true);
    expect(steps[1]?.classList.contains('step--done')).toBe(true);
    expect(steps[2]?.classList.contains('step--done')).toBe(true);
    expect(text(el)).toContain('Publication initialized');
  });

  it('omits the proposal list when none are pending yet', async () => {
    const el = await mountLit<S2SInitProgressModal>('s2s-init-progress-modal', {
      open: true,
      phase: 'creating',
      proposals: [],
    });

    expect(el.shadowRoot?.querySelectorAll('.proposal').length).toBe(0);
  });
});
