import { describe, it, expect, vi } from 'vitest';
import type { ToggleButton } from '../../src/components/toggle-button';
import { mountLit } from '../helpers/mount';
import '../../src/components/toggle-button';

describe('toggle-button', () => {
  it('renders the label', async () => {
    const el = await mountLit<ToggleButton>('toggle-button', { label: 'Enable' });
    expect(el.shadowRoot?.textContent).toContain('Enable');
  });

  it('starts in the off state by default', async () => {
    const el = await mountLit<ToggleButton>('toggle-button', { label: 'x' });
    expect(el.bool).toBe(false);
    expect(el.shadowRoot?.querySelector('.toggle-lid')?.classList.contains('active')).toBe(false);
  });

  it('toggles on and dispatches a composed toggle event with detail.checked', async () => {
    const el = await mountLit<ToggleButton>('toggle-button', { label: 'x' });
    const onToggle = vi.fn();
    el.addEventListener('toggle', onToggle);

    (el.shadowRoot?.querySelector('.toggle-lid') as HTMLElement).click();
    await el.updateComplete;

    expect(el.bool).toBe(true);
    expect(el.shadowRoot?.querySelector('.toggle-lid')?.classList.contains('active')).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const detail = onToggle.mock.calls[0][0].detail;
    expect(detail.checked).toBe(true);
  });

  it('toggles off when mounted in the on state', async () => {
    const el = await mountLit<ToggleButton>('toggle-button', { bool: true, label: 'x' });
    expect(el.shadowRoot?.querySelector('.toggle-lid')?.classList.contains('active')).toBe(true);

    (el.shadowRoot?.querySelector('.toggle-lid') as HTMLElement).click();
    await el.updateComplete;

    expect(el.bool).toBe(false);
    expect(el.shadowRoot?.querySelector('.toggle-lid')?.classList.contains('active')).toBe(false);
  });
});
