import { S2SProtocolInfo } from '@s2s/soul2soul-shared';
import { Observable, Listener } from './observable.js';



import { } from './storage.js';

export class ProtocolStore {
  private observable: Observable<S2SProtocolInfo | undefined>;

  constructor() {
    this.observable = new Observable<S2SProtocolInfo | undefined>(undefined);
  }

  get info(): S2SProtocolInfo | undefined {
    return this.observable.get();
  }

  set(info: S2SProtocolInfo): void {
    this.observable.set(info);
  }

  clear(): void {
    this.observable.set(undefined);
  }

  subscribe(listener: Listener<S2SProtocolInfo | undefined>): () => void {
    return this.observable.subscribe(listener);
  }
}