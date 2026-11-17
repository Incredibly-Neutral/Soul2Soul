import { S2SManifest } from '@s2s/soul2soul-shared';
import { Observable, Listener } from './observable.js';



import { } from './storage.js';

export class ProtocolStore {
  private observable: Observable<S2SManifest | undefined>;

  constructor() {
    this.observable = new Observable<S2SManifest | undefined>(undefined);
  }

  get info(): S2SManifest | undefined {
    return this.observable.get();
  }

  set(info: S2SManifest): void {
    this.observable.set(info);
  }

  clear(): void {
    this.observable.set(undefined);
  }

  subscribe(listener: Listener<S2SManifest | undefined>): () => void {
    return this.observable.subscribe(listener);
  }
}