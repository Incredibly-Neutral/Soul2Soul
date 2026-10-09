// s2s-check.test.ts — component (browser) tests for the generic <s2s-check>
// control. Pure presentational + input handling: no store/contract/Safe
// knowledge, so it mounts standalone with just label/placeholder/result props.
// The parent-driven flow is: submit → 's2s-check' CustomEvent(detail.value) →
// parent pushes .result back → pill reflects it.

import { describe, it, expect, vi } from 'vitest';
import type { S2SCheck } from '../../src/components/s2s-check';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-check';

/** Type a value into the (controlled) input and let state sync. */
async function typeValue(el: S2SCheck, value: string) {
  const input = el.shadowRoot!.querySelector('input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  await el.updateComplete;
  return input;
}

/** Click the check-icon button. */
function clickCheck(el: S2SCheck) {
  (el.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
}

describe('s2s-check', () => {
  it('renders the descriptive label and the input placeholder hint', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', {
      label: 'check if genesis id has a deal',
      placeholder: '0x… genesis',
    });

    expect(el.shadowRoot?.textContent).toContain('check if genesis id has a deal');
    const input = el.shadowRoot!.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe('0x… genesis');
    // The only action affordance is a check-icon button at the end.
    expect(el.shadowRoot?.querySelector('button')).not.toBeNull();
  });

  it('submits via the check button, dispatching s2s-check with the trimmed detail.value', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const dispatched: string[] = [];
    el.addEventListener('s2s-check', (e: Event) =>
      dispatched.push((e as CustomEvent).detail.value as string),
    );

    await typeValue(el, ' 0xabc ');
    clickCheck(el);

    expect(dispatched).toEqual(['0xabc']);
  });

  it('submits via Enter in the input', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const dispatched: string[] = [];
    el.addEventListener('s2s-check', (e: Event) =>
      dispatched.push((e as CustomEvent).detail.value as string),
    );

    const input = await typeValue(el, '0xabc');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(dispatched).toEqual(['0xabc']);
  });

  it('emits no event and refocuses the input on an empty/whitespace submit', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const dispatched: string[] = [];
    el.addEventListener('s2s-check', (e: Event) =>
      dispatched.push((e as CustomEvent).detail.value as string),
    );

    const input = await typeValue(el, '   ');
    clickCheck(el);
    await el.updateComplete;

    expect(dispatched).toEqual([]);
    await vi.waitFor(() => expect(el.shadowRoot!.activeElement).toBe(input));
  });

  it('shows the submitting state (disabled input) until the parent pushes a result', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const input = await typeValue(el, '0xabc');

    clickCheck(el); // sets submitting=true
    await el.updateComplete;
    expect(input.disabled).toBe(true);

    // Parent pushes a terminal result → submitting resets, control re-enabled.
    el.result = 'pass';
    await el.updateComplete;
    expect(input.disabled).toBe(false);
  });

  it('reflects result state on the host attribute and swaps the icon', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });

    el.result = 'pending';
    await el.updateComplete;
    expect(el.getAttribute('result')).toBe('pending');
    expect(el.shadowRoot?.querySelector('ph-check')).not.toBeNull();

    el.result = 'pass';
    await el.updateComplete;
    expect(el.getAttribute('result')).toBe('pass');
    expect(el.shadowRoot?.querySelector('ph-check')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('ph-x')).toBeNull();

    el.result = 'fail';
    await el.updateComplete;
    expect(el.getAttribute('result')).toBe('fail');
    expect(el.shadowRoot?.querySelector('ph-x')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('ph-check')).toBeNull();

    el.result = 'error';
    await el.updateComplete;
    expect(el.getAttribute('result')).toBe('error');
  });

  it('dims the input while pending and restores it on a terminal result', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const input = el.shadowRoot!.querySelector('input') as HTMLInputElement;

    el.result = 'pending';
    await el.updateComplete;
    expect(input.disabled).toBe(true);

    el.result = 'pass';
    await el.updateComplete;
    expect(input.disabled).toBe(false);
  });

  it('renders the optional message beside the pill and hides it when cleared', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', {
      label: 'check',
      message: 'has a deal',
    });
    expect(el.shadowRoot?.textContent).toContain('has a deal');

    el.message = '';
    await el.updateComplete;
    expect(el.shadowRoot?.textContent).not.toContain('has a deal');
  });

  it('reset() clears the value, result and message', async () => {
    const el = await mountLit<S2SCheck>('s2s-check', { label: 'check' });
    const input = await typeValue(el, '0xabc');

    el.result = 'pass';
    el.message = 'has a deal';
    await el.updateComplete;

    el.reset();
    await el.updateComplete;

    expect(input.value).toBe('');
    expect(el.result).toBe('idle');
    expect(el.getAttribute('result')).toBe('idle');
    expect(el.message).toBe('');
    expect(el.shadowRoot?.textContent).not.toContain('has a deal');
  });
});
