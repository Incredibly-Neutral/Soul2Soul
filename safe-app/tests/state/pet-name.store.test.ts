import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installLS, type LSStub } from './_helpers.js';
import { PetNameStore } from '../../src/state/pet-name.store.js';
import { loadPetNamesFromStorage, savePetNamesToStorage } from '../../src/state/storage.js';

describe('PetNameStore (local-only pet names)', () => {
  let ls: LSStub;

  beforeEach(() => {
    ls = installLS();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts empty when nothing is stored', () => {
    const s = new PetNameStore();
    expect(s.get('0xabc')).toBeUndefined();
    expect(s.has('0xabc')).toBe(false);
  });

  it('hydrates from localStorage on construction', () => {
    savePetNamesToStorage({ '0xabc123': 'bob' });
    const s = new PetNameStore();
    expect(s.get('0xabc123')).toBe('bob');
  });

  it('persists a set name and survives a fresh store', () => {
    const s = new PetNameStore();
    s.set('0xDEADBEEF', '  alice  ');
    // Trimmed on the way in.
    expect(s.get('0xDEADBEEF')).toBe('alice');
    expect(ls.getItem('pet-names')).toContain('alice');

    const fresh = new PetNameStore();
    expect(fresh.get('0xDEADBEEF')).toBe('alice');
  });

  it('looks up addresses case-insensitively (checksum ≠ raw)', () => {
    const s = new PetNameStore();
    s.set('0xAbC123', 'casey');
    expect(s.get('0xabc123')).toBe('casey');
    expect(s.get('0xABC123')).toBe('casey');
  });

  it('collides did:ethr-prefixed and bare addresses to the same name', () => {
    const s = new PetNameStore();
    s.set('did:ethr:0xAbC123', 'casey');
    expect(s.get('0xabc123')).toBe('casey');
    expect(s.get('did:ethr:0xABC123')).toBe('casey');
  });

  it('setting an empty / whitespace name removes the entry', () => {
    const s = new PetNameStore();
    s.set('0xaaa', 'dave');
    s.set('0xaaa', '   ');
    expect(s.has('0xaaa')).toBe(false);
    expect(ls.getItem('pet-names')).toBe('{}');
  });

  it('remove deletes just that address', () => {
    const s = new PetNameStore();
    s.set('0xaaa', 'dave');
    s.set('0xbbb', 'erin');
    s.remove('0xaaa');
    expect(s.has('0xaaa')).toBe(false);
    expect(s.get('0xbbb')).toBe('erin');
  });

  it('clear empties the map and the storage key', () => {
    const s = new PetNameStore();
    s.set('0xaaa', 'dave');
    s.clear();
    expect(s.get('0xaaa')).toBeUndefined();
    expect(ls.getItem('pet-names')).toBe('{}');
  });

  it('ignores set/remove on an empty address', () => {
    const s = new PetNameStore();
    s.set('', 'nobody');
    expect(ls.getItem('pet-names')).toBeNull();
    s.remove('');
  });

  it('notifies subscribers on change (live re-render across instances)', () => {
    const s = new PetNameStore();
    const listener = vi.fn();
    const unsub = s.subscribe(listener);
    s.set('0xaaa', 'dave');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    s.remove('0xaaa');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not write storage on construction (no no-op round trip)', () => {
    const s = new PetNameStore();
    expect(ls.getItem('pet-names')).toBeNull();
  });

  it('tolerates a broken localStorage payload', () => {
    ls.setItem('pet-names', 'not json{{{');
    const s = new PetNameStore();
    expect(s.get('0xabc')).toBeUndefined();
  });

  it('loadPetNamesFromStorage rejects non-object payloads', () => {
    savePetNamesToStorage({ '0x1': 'a' });
    expect(loadPetNamesFromStorage()).toEqual({ '0x1': 'a' });
    ls.setItem('pet-names', JSON.stringify(['not', 'an', 'object']));
    expect(loadPetNamesFromStorage()).toBeNull();
  });
});
