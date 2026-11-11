import { authorAddress } from '@s2s/soul2soul-shared';

import { Observable, Listener } from './observable.js';
import { loadPetNamesFromStorage, savePetNamesToStorage } from './storage.js';

export type PetNameMap = Record<string, string>;

/**
 * Local-only pet names: a pseudonymous display-name map keyed by
 * (lowercased) address. Persisted to localStorage and kept in memory so every
 * <pet-name> instance reflects edits live.
 *
 * Privacy invariant: pet names are user-local nicknames. They are never
 * written to an on-chain record and never sent over the network — the public
 * identity stays the raw address, and each viewer sees only the names *they*
 * assigned. Addresses are normalised to lowercase so 0xAbC == 0xabc.
 */
export class PetNameStore {
  private observable: Observable<PetNameMap>;
  private initialized = false;

  constructor() {
    this.observable = new Observable<PetNameMap>(loadPetNamesFromStorage() ?? {});

    // Auto-save on changes — skip the initial fire (constructor load already
    // matches what's in storage; saving it back would be a no-op write).
    this.observable.subscribe((names) => {
      if (this.initialized) savePetNamesToStorage(names);
    });

    this.initialized = true;
  }

  /** Normalised lookup key — addresses are case-insensitive, and a value
   *  pinned before the change resolves to the address it names, because the key
   *  goes through shared's `authorAddress()`. */
  private static key(address: string): string {
    return authorAddress(address);
  }

  get(address: string): string | undefined {
    if (!address) return undefined;
    return this.observable.get()[PetNameStore.key(address)];
  }

  has(address: string): boolean {
    return this.get(address) !== undefined;
  }

  /**
   * Set a pet name for an address. An empty / whitespace-only name removes the
   * entry (acts as "clear the pet name, go back to showing the address").
   */
  set(address: string, name: string): void {
    if (!address) return;
    const trimmed = name.trim();
    this.observable.update((names) => {
      const next = { ...names };
      const key = PetNameStore.key(address);
      if (trimmed) next[key] = trimmed;
      else delete next[key];
      return next;
    });
  }

  remove(address: string): void {
    if (!address) return;
    this.observable.update((names) => {
      const next = { ...names };
      delete next[PetNameStore.key(address)];
      return next;
    });
  }

  clear(): void {
    this.observable.set({});
  }

  subscribe(listener: Listener<PetNameMap>): () => void {
    return this.observable.subscribe(listener);
  }
}

/** App-wide singleton. Import and use directly from components. */
export const petNameStore = new PetNameStore();
