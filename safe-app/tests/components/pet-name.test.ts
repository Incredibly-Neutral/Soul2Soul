// pet-name.test.ts — component (browser) tests for the pet-name atom.
//
// Real localStorage in the browser sandbox, plus the shared petNameStore
// singleton (hydrated once per page). Reset both between tests so each spec
// starts with no pet names.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PetName } from '../../src/components/pet-name';
import { petNameStore } from '../../src/state/pet-name.store';
import { mountLit } from '../helpers/mount';
import '../../src/components/pet-name';

describe('pet-name', () => {
  beforeEach(() => {
    localStorage.clear();
    petNameStore.clear();
  });

  const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

  it('renders the shortened address when no pet name is set', async () => {
    const el = await mountLit<PetName>('pet-name', { value: ADDR });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('0x12...5678');
    expect(text.title).toBe(ADDR);
  });

  it('renders the pet name when the address already has one', async () => {
    petNameStore.set(ADDR, 'bob');
    const el = await mountLit<PetName>('pet-name', { value: ADDR });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('bob');
    expect(text.classList.contains('has-name')).toBe(true);
    expect(text.title).toBe(ADDR);
  });

  it('lets the pet name win over an explicit display prop', async () => {
    petNameStore.set(ADDR, 'bob');
    const el = await mountLit<PetName>('pet-name', { value: ADDR, display: 'override' });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('bob');
  });

  it('uses the display prop as the fallback when there is no pet name', async () => {
    const el = await mountLit<PetName>('pet-name', { value: ADDR, display: 'override' });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('override');
  });

  it('opens the inline editor on pencil click', async () => {
    const el = await mountLit<PetName>('pet-name', { value: ADDR });
    (el.shadowRoot?.querySelector('button.btn-edit') as HTMLButtonElement).click();
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input.pet-input') as HTMLInputElement;
    expect(input).toBeTruthy();
  });

  it('saving a name persists it to store + localStorage and shows it', async () => {
    const el = await mountLit<PetName>('pet-name', { value: ADDR });
    (el.shadowRoot?.querySelector('button.btn-edit') as HTMLButtonElement).click();
    await el.updateComplete;

    const input = el.shadowRoot?.querySelector('input.pet-input') as HTMLInputElement;
    input.value = 'alice';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot?.querySelector('button.btn-save') as HTMLButtonElement).click();
    await el.updateComplete;

    expect(petNameStore.get(ADDR)).toBe('alice');
    expect(localStorage.getItem('pet-names')).toContain('alice');
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('alice');
  });

  it('saving an empty name clears the pet name back to the address', async () => {
    petNameStore.set(ADDR, 'bob');
    const el = await mountLit<PetName>('pet-name', { value: ADDR });

    (el.shadowRoot?.querySelector('button.btn-edit') as HTMLButtonElement).click();
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input.pet-input') as HTMLInputElement;
    expect(input.value).toBe('bob'); // draft prefilled with current name
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot?.querySelector('button.btn-save') as HTMLButtonElement).click();
    await el.updateComplete;

    expect(petNameStore.has(ADDR)).toBe(false);
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('0x12...5678');
  });

  it('cancel discards the draft', async () => {
    petNameStore.set(ADDR, 'bob');
    const el = await mountLit<PetName>('pet-name', { value: ADDR });

    (el.shadowRoot?.querySelector('button.btn-edit') as HTMLButtonElement).click();
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input.pet-input') as HTMLInputElement;
    input.value = 'changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (el.shadowRoot?.querySelector('button.btn-cancel') as HTMLButtonElement).click();
    await el.updateComplete;

    expect(petNameStore.get(ADDR)).toBe('bob');
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('bob');
  });

  it('copies the full address on copy-button click', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const el = await mountLit<PetName>('pet-name', { value: ADDR });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDR));
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('button')?.classList.contains('copied')).toBe(true),
    );
  });

  it('strips the did:ethr prefix from display and title', async () => {
    const el = await mountLit<PetName>('pet-name', {
      value: 'did:ethr:0x1234567890abcdef1234567890abcdef12345678',
    });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('0x12...5678');
    expect(text.title).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('copies the bare address without the did:ethr prefix', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const el = await mountLit<PetName>('pet-name', {
      value: 'did:ethr:0x1234567890abcdef1234567890abcdef12345678',
    });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('0x1234567890abcdef1234567890abcdef12345678'),
    );
  });

  it('readonly renders the label only (no copy or pencil buttons)', async () => {
    const el = await mountLit<PetName>('pet-name', { value: ADDR, readonly: true });
    expect(el.shadowRoot?.querySelector('button')).toBeNull();
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('0x12...5678');
  });

  it('reflects a pet name set on another instance live', async () => {
    const a = await mountLit<PetName>('pet-name', { value: ADDR });
    await mountLit<PetName>('pet-name', { value: ADDR });
    petNameStore.set(ADDR, 'zed');
    await a.updateComplete;
    const text = a.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('zed');
  });

  it('renders an em dash for an empty value', async () => {
    const el = await mountLit<PetName>('pet-name', { value: '' });
    const text = el.shadowRoot?.querySelector('.text') as HTMLSpanElement;
    expect(text.textContent).toBe('—');
  });
});
