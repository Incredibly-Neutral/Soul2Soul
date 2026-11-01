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
 * Leading-edge rate limiter. The first line shows immediately, later lines are dropped until the
 * interval has passed. Deliberately timer-free: a trailing timer could fire after the progress
 * notification is gone (cancelled or finished) and report into a disposed notification.
 */
export function createLineThrottle(
  report: (line: string) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  now: () => number = Date.now,
): (line: string) => void {
  let lastReportAt: number | undefined;

  return (line: string): void => {
    const at = now();
    if (lastReportAt !== undefined && at - lastReportAt < intervalMs) return;
    lastReportAt = at;
    report(line);
  };
}
