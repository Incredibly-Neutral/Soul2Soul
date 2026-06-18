import { Observable, Listener } from './observable.js';
import { loadRootFromStorage, saveRootToStorage } from './storage.js';

export class WebStore {
  private observable: Observable<string | null>;
  private unsubscribe: () => void

  constructor() {
    const record = loadRootFromStorage();
    this.observable = new Observable<string | null>(record ?? null);
    this.unsubscribe = this.observable.subscribe(saveRootToStorage)

    this.observable.subscribe((record) => {
      saveRootToStorage(record);
    });
  }

  get(): string | null {
    return this.observable.get();
  }

  set(record: string): void {
    this.observable.set(record);
  }

  clear(): void {
    this.observable.set(null);
  }

  subscribe(listener: Listener<string | null>): () => void {
    return this.observable.subscribe(listener);
  }

  destroy(): void {
    this.unsubscribe()
  }
}