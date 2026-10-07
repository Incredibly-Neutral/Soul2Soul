/**
 * Shared test helpers for the state-layer suite (tests/state/*).
 *
 * The vitest base config runs in the `node` environment, so there is no
 * real `localStorage`. The state layer reads/writes the `localStorage`
 * global at call time (never at module-eval time), so we can install an
 * in-memory stub on `globalThis` and it behaves like the real API
 * (getItem/setItem/removeItem/clear/key/length), plus knobs to simulate an
 * unavailable store and quota exhaustion.
 */

export interface LSStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
  /** Inner map so tests can inspect / seed storage. */
  _map: Map<string, string>;
}

export interface LSOptions {
  /** getItem throws (storage unavailable on read). */
  failGet?: boolean;
  /** setItem throws (quota / storage unavailable on write). */
  failSet?: boolean;
}

export function createLS(opts: LSOptions = {}): LSStub {
  const m = new Map<string, string>();
  return {
    getItem(key) {
      if (opts.failGet) throw new Error('storage unavailable (read)');
      return m.has(key) ? (m.get(key) as string) : null;
    },
    setItem(key, value) {
      if (opts.failSet) {
        const err = new Error('The quota has been exceeded.') as Error & {
          name: string;
        };
        err.name = 'QuotaExceededError';
        throw err;
      }
      m.set(key, String(value));
    },
    removeItem(key) {
      m.delete(key);
    },
    clear() {
      m.clear();
    },
    key(index) {
      return [...m.keys()][index] ?? null;
    },
    get length() {
      return m.size;
    },
    _map: m,
  };
}

/** Install a stub on globalThis.localStorage and return it. */
export function installLS(opts: LSOptions = {}): LSStub {
  const ls = createLS(opts);
  (globalThis as Record<string, unknown>).localStorage = ls;
  return ls;
}

/** Convenience seed: JSON.stringify a value under a storage key. */
export function seed(ls: LSStub, key: string, value: unknown): void {
  ls.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
}
