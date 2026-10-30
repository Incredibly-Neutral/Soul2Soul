import { Observable, Listener } from './observable.js';
import { Deal } from '../types/index.js';
import { loadDealsFromStorage, loadOffersFromStorage, saveDealsToStorage, saveOffersToStorage } from './storage.js'

export class DealStore {
  private observable: Observable<Deal[]>;
  private pendingObservable: Observable<Deal[]>;
  private initialized = false;

  constructor() {
    const stored = loadDealsFromStorage();
    const pendingStored = loadOffersFromStorage();
    const deals = stored ? Object.values(stored).filter(Boolean) as Deal[] : [];
    const pending = pendingStored ? Object.values(pendingStored).filter(Boolean) as Deal[] : [];

    this.observable = new Observable<Deal[]>(deals);
    this.pendingObservable = new Observable<Deal[]>(pending);


    // Auto-save on changes
    this.observable.subscribe((deals) => {
      if (this.initialized) { // ← skip initial fire
        const map = Object.fromEntries(deals.map(s => [s.genesis, s]));
        saveDealsToStorage(map);
      }
    });

    this.pendingObservable.subscribe((pending) => {
      if (this.initialized) { // ← skip initial fire
        const map = Object.fromEntries(pending.map(s => [s.genesis, s]));
        saveOffersToStorage(map);
      }
    });

    this.initialized = true;
  }

  get all(): Deal[] {
    return this.observable.get();
  }

  set(deals: Deal[]): void {
    this.observable.set(deals);
  }

  add(deal: Deal): void {
    this.observable.update(current => {
      const index = current.findIndex(s => s.genesis === deal.genesis);
      if (index === -1) return [...current, deal];
      const updated = [...current];
      updated[index] = deal;
      return updated;
    });
  }

  remove(genesis: string): void {
    this.observable.update(current => current.filter(s => s.genesis !== genesis));
  }

  clear(): void {
    this.observable.set([]);
  }

  subscribe(listener: Listener<Deal[]>): () => void {
    return this.observable.subscribe(listener);
  }

   // ── Pending offers ─────────────────────────────────────────────────────────

  get allPending(): Deal[] {
    return this.pendingObservable.get();
  }

  setPending(deals: Deal[]): void {
    this.pendingObservable.set(deals);
  }

  addPending(deal: Deal): void {
    this.pendingObservable.update(current => {
      const index = current.findIndex(s => s.genesis === deal.genesis);
      if (index === -1) return [...current, deal];
      const updated = [...current];
      updated[index] = deal;
      return updated;
    });
  }

  removePending(genesis: string): void {
    this.pendingObservable.update(current => current.filter(s => s.genesis !== genesis));
  }

  clearPending(): void {
    this.pendingObservable.set([]);
  }

  subscribeToPending(listener: Listener<Deal[]>): () => void {
    return this.pendingObservable.subscribe(listener);
  }
}