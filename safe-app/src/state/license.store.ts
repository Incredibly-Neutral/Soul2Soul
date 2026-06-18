import { Observable, Listener } from './observable.js';
import { License } from '../types/index.js';
import { loadLicensesFromStorage, loadPendingLicensesFromStorage, saveLicensesToStorage, savePendingLicensesToStorage } from './storage.js'

export class LicenseStore {
  private observable: Observable<License[]>;
  private pendingObservable: Observable<License[]>;
  private initialized = false;

  constructor() {
    const stored = loadLicensesFromStorage();
    const pendingStored = loadPendingLicensesFromStorage();
    const licenses = stored ? Object.values(stored).filter(Boolean) as License[] : [];
    const pending = pendingStored ? Object.values(pendingStored).filter(Boolean) as License[] : [];

    this.observable = new Observable<License[]>(licenses);
    this.pendingObservable = new Observable<License[]>(pending);


    // Auto-save on changes
    this.observable.subscribe((licenses) => {
      if (this.initialized) { // ← skip initial fire
        const map = Object.fromEntries(licenses.map(s => [s.contentId, s]));
        saveLicensesToStorage(map);
      }
    });

    this.pendingObservable.subscribe((pending) => {
      if (this.initialized) { // ← skip initial fire
        const map = Object.fromEntries(pending.map(s => [s.contentId, s]));
        savePendingLicensesToStorage(map);
      }
    });

    this.initialized = true;
  }

  get all(): License[] {
    return this.observable.get();
  }

  set(licenses: License[]): void {
    this.observable.set(licenses);
  }

  add(license: License): void {
    this.observable.update(current => {
      const index = current.findIndex(s => s.contentId === license.contentId);
      if (index === -1) return [...current, license];
      const updated = [...current];
      updated[index] = license;
      return updated;
    });
  }

  remove(contentId: string): void {
    this.observable.update(current => current.filter(s => s.contentId !== contentId));
  }

  clear(): void {
    this.observable.set([]);
  }

  subscribe(listener: Listener<License[]>): () => void {
    return this.observable.subscribe(listener);
  }

   // ── Pending licenses ─────────────────────────────────────────────────────────

  get allPending(): License[] {
    return this.pendingObservable.get();
  }

  setPending(licenses: License[]): void {
    this.pendingObservable.set(licenses);
  }

  addPending(license: License): void {
    this.pendingObservable.update(current => {
      const index = current.findIndex(s => s.contentId === license.contentId);
      if (index === -1) return [...current, license];
      const updated = [...current];
      updated[index] = license;
      return updated;
    });
  }

  removePending(contentId: string): void {
    this.pendingObservable.update(current => current.filter(s => s.contentId !== contentId));
  }

  clearPending(): void {
    this.pendingObservable.set([]);
  }

  subscribeToPending(listener: Listener<License[]>): () => void {
    return this.pendingObservable.subscribe(listener);
  }
}