import { Observable, Listener } from './observable.js';
import { OnChainRecord } from './types.js';
import { loadRecordFromStorage, saveRecordToStorage } from './storage.js';

export class RecordStore {
  private observable: Observable<Record<string, OnChainRecord> | null>;
  initialized = false;

  constructor() {
    const record = loadRecordFromStorage();
    this.observable = new Observable<Record<string, OnChainRecord> | null>(record ?? null);

    // this.observable.subscribe((record) => {
    //   if (this.initialized) saveRecordToStorage(record); // ← skip initial fire
    // });

    this.initialized = true;
  }

  get(key: string): OnChainRecord | null {
    return this.observable.get()?.[key] ?? null;
  }

  all(): Record<string, OnChainRecord> | null {
    return this.observable.get();
  }

  set(record: OnChainRecord): void {
    this.observable.update(current => ({
      ...current,
      [record.key]: record
    }));
  }

  setAll(records: OnChainRecord[]): void {
    const map = Object.fromEntries(records.map(r => [r.key, r]));
    this.observable.set(map);
  }

  remove(key: string): void {
    this.observable.update(current => {
      if (!current) return null;
      const { [key]: _, ...rest } = current;
      return rest;
    });
  }

  clear(): void {
    this.observable.set(null);
  }

  subscribe(listener: Listener<Record<string, OnChainRecord> | null>): () => void {
    return this.observable.subscribe(listener);
  }
}