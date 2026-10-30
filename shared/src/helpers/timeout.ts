/**
 * True when `error` (or anything in its `cause` chain) is an abort.
 *
 * Node's `fetch` does NOT reject an aborted request with an `AbortError`: it
 * rejects with `TypeError: fetch failed` and hides the abort one or two levels
 * down in `cause` (`AbortError`, `UND_ERR_ABORTED`, `ABORT_ERR`). Checking only
 * `error.name === 'AbortError'` therefore never matches, and a timeout gets
 * reported as the world's least useful message — "fetch failed".
 */
export const isAbortError = (error: unknown): boolean => {
  let current: any = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.name === 'AbortError') return true;
    if (current.code === 'UND_ERR_ABORTED' || current.code === 'ABORT_ERR') return true;
    current = current.cause;
  }
  return false;
};

export const callWithTimeout = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 25_000
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error: any) {
    // An abort caused by OUR timer is a timeout; an abort from anywhere else
    // still reads as one, which is close enough and never hides a real cause
    // (the caller prints the cause chain).
    if (isAbortError(error)) {
      throw new Error(`Timed out after ${timeoutMs / 1000}s`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
