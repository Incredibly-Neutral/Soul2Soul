/**
 * The progress-line throttle: pure, fake-clock tests (no timers, no vscode).
 *
 * `progress.report` crosses the remote boundary on every call, so a firehose stderr must not be
 * forwarded line for line — SPEC §UI contract asks for the last line, throttled.
 */

import { describe, expect, it } from 'vitest';

import { PROGRESS_INTERVAL_MS, createLineThrottle } from '../src/progress';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 0;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('createLineThrottle', () => {
  it('reports the first line immediately', () => {
    const seen: string[] = [];
    const { now } = clock();
    const report = createLineThrottle((line) => seen.push(line), 100, now);

    report('uploading');

    expect(seen).toEqual(['uploading']);
  });

  it('drops lines inside the window and reports again after it', () => {
    const seen: string[] = [];
    const { now, advance } = clock();
    const report = createLineThrottle((line) => seen.push(line), 100, now);

    report('one');
    advance(99);
    report('two');
    expect(seen).toEqual(['one']);

    advance(1);
    report('three');
    expect(seen).toEqual(['one', 'three']);
  });

  it('flush reports the last line the throttle dropped', () => {
    const seen: string[] = [];
    const report = createLineThrottle((line) => seen.push(line), 100, clock().now);

    report('uploading');
    report('pinning');
    report('done');
    expect(seen).toEqual(['uploading']);

    report.flush();
    expect(seen).toEqual(['uploading', 'done']);
  });

  it('flush is a no-op when the last line was already reported', () => {
    const seen: string[] = [];
    const report = createLineThrottle((line) => seen.push(line), 100, clock().now);

    report('only');
    report.flush();
    expect(seen).toEqual(['only']);
  });

  it('flush is a no-op before any line arrives', () => {
    const seen: string[] = [];
    const report = createLineThrottle((line) => seen.push(line), 100, clock().now);

    report.flush();
    expect(seen).toEqual([]);
  });

  it('caps a fast stream at ~10 updates a second', () => {
    const seen: string[] = [];
    const { now, advance } = clock();
    const report = createLineThrottle((line) => seen.push(line), 100, now);

    for (let index = 0; index < 1000; index += 1) {
      report(`line ${index}`);
      advance(1);
    }

    expect(seen.length).toBeLessThanOrEqual(11);
    expect(seen[0]).toBe('line 0');
  });

  it('defaults to ten updates a second', () => {
    expect(PROGRESS_INTERVAL_MS).toBe(100);
  });
});
