/**
 * Progress-line throttling — pure, no `vscode` import, so it unit-tests in plain node.
 *
 * A long upload streams hundreds of stderr lines. `progress.report` is a cross-process message to
 * the client, so forwarding every line is both wasteful and visually useless: the spec asks for
 * the **last** stderr line, throttled (SPEC-author-vscode §UI contract).
 */

/** At most ~10 updates/sec: fast enough to look live, slow enough not to flood the RPC. */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * Leading-edge rate limiter with an explicit flush. The first line shows immediately, later lines
 * are dropped until the interval has passed — and `flush()` reports the last dropped line, which is
 * the one the spec names (SPEC-author-vscode §UI contract). Deliberately timer-free: a trailing
 * timer could fire after the progress notification is gone (cancelled, or already finished) and
 * report into a disposed notification.
 */
export interface LineThrottle {
  (line: string): void;
  /** Report the last line if it was dropped. Call once, when the run has finished. */
  flush(): void;
}

export function createLineThrottle(
  report: (line: string) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  now: () => number = Date.now,
): LineThrottle {
  let lastReportAt: number | undefined;
  let lastReported: string | undefined;
  let pending: string | undefined;

  const throttle = (line: string): void => {
    pending = line;
    const at = now();
    if (lastReportAt !== undefined && at - lastReportAt < intervalMs) return;
    lastReportAt = at;
    lastReported = line;
    report(line);
  };

  throttle.flush = (): void => {
    if (pending === undefined || pending === lastReported) return;
    lastReported = pending;
    report(pending);
  };

  return throttle as LineThrottle;
}
