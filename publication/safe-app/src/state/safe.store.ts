import { Observable, Listener } from './observable.js';
import { SafeInfo } from '../types/index.js';
import { } from './storage.js';

export class SafeStore {
  private observable: Observable<SafeInfo | undefined>;

  constructor() {
    this.observable = new Observable<SafeInfo | undefined>(undefined);
  }

  get info(): SafeInfo | undefined {
    return this.observable.get();
  }

  set(info: SafeInfo): void {
    this.observable.set(info);
  }

  clear(): void {
    this.observable.set(undefined);
  }

  subscribe(listener: Listener<SafeInfo | undefined>): () => void {
    return this.observable.subscribe(listener);
  }
}