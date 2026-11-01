/**
 * Per-document UI state: the last result, and an in-flight mutex.
 *
 * Keyed by document URI string. Pure — no `vscode` import, so it unit-tests in plain node.
 *
 * The mutex matters more here than it did in Neovim: `withProgress` gives the user a cancel
 * button and the palette gives them a second invocation, so two runs on one document must
 * never race. `begin` is the gate; `end` is release-on-failure too, via `finally`.
 */

import type { ResultObject } from './parse';

export interface LastResult {
  result: ResultObject;
  /** The action the binary reported (`offer`, `upload`, …), for the detail view title. */
  action: string | undefined;
  contaminated: boolean;
  finishedAt: number;
  durationMs: number;
}

export interface StateStats {
  /** How many results this session had to be recovered from contaminated stdout. */
  contaminated: number;
  runs: number;
  failures: number;
}

export interface State {
  setLast(key: string, value: LastResult): void;
  getLast(key: string): LastResult | undefined;
  clear(key: string): void;
  /** False when a run is already in flight for this document. */
  begin(key: string): boolean;
  end(key: string): void;
  isBusy(key: string): boolean;
  readonly stats: StateStats;
}

export function createState(): State {
  const last = new Map<string, LastResult>();
  const inflight = new Set<string>();
  const stats: StateStats = { contaminated: 0, runs: 0, failures: 0 };

  return {
    setLast(key, value) {
      last.set(key, value);
      stats.runs += 1;
      if (value.contaminated) stats.contaminated += 1;
    },
    getLast(key) {
      return last.get(key);
    },
    clear(key) {
      last.delete(key);
      inflight.delete(key);
    },
    begin(key) {
      if (inflight.has(key)) return false;
      inflight.add(key);
      return true;
    },
    end(key) {
      inflight.delete(key);
    },
    isBusy(key) {
      return inflight.has(key);
    },
    stats,
  };
}
