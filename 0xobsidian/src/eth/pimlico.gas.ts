/**
 * Pimlico gas-price utilities shared by the safe & simple permissionless
 * services.
 *
 * Publishing on Base intermittently fails with `TimeoutError: The request took
 * too long to respond` on `pimlico_getUserOperationGasPrice` — typically the
 * FIRST Pimlico call in a flow after an idle period, when the long-lived
 * singleton Pimlico transport reuses a stale pooled socket the load balancer
 * has dropped. There was no app-level retry, no gas-price cache and no
 * in-flight dedupe, so a cold/stale socket + N concurrent publishes fanning out
 * N identical requests made the failure likely and slow to recover.
 *
 * This module provides:
 *   1. `warmUpPimlico` — a best-effort no-op RPC fired on transport creation so
 *      the first REAL gas-price call is not also the first touch on a
 *      cold/stale socket.
 *   2. `createGasPriceFetcher` — short-TTL cache + shared in-flight promise so
 *      N concurrent publishes fire ONE Pimlico request (kills the fan-out).
 *   3. `withRetryBackoff` — exponential backoff + jitter on transport/timeout
 *      failures for the (idempotent) gas-price read.
 */

export interface GasPriceResult {
  slow: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  standard: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  fast: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

/** Minimal surface of the Pimlico/viem client used by warmUpPimlico. */
interface WarmUpClient {
  request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** Substrings that identify a transient transport/timeout failure worth retrying. */
const RETRYABLE_MARKERS = [
  "timeout",
  "request took too long",
  "etimedout",
  "econnreset",
  "socket",
  "could not connect",
  "network",
  "fetch failed",
  "load failed",
  "503",
  "502",
  "504",
  "429",
  "rate limit",
];

/** Best-effort no-op RPC so the first gas-price call hits a warm socket. */
export function warmUpPimlico(client: WarmUpClient | null | undefined): void {
  if (!client || typeof client.request !== "function") return;

  const noop = Promise.race([
    client.request({ method: "eth_chainId" }),
    sleep(3000).then(() => {
      throw new Error("warm-up timed out");
    }),
  ]);
  // Fire-and-forget: a failed warm-up must never break account init.
  noop.catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[pimlico] warm-up failed (best-effort):", reason);
  });
}

/** Exponential backoff + jitter (≈50–100% of each step). */
function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const step = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.floor(step * (0.5 + Math.random()));
}

const errorMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : String(err);

/**
 * Retry an async operation with exponential backoff + jitter on retryable
 * (transport/timeout) failures. Gas-price reads are idempotent, so retrying
 * them is safe.
 */
export async function withRetryBackoff<T>(
  fn: () => Promise<T> | T,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 250, maxDelayMs = 5000 } = opts;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt >= retries) throw err;

      const marker = errorMessage(err).toLowerCase();
      const retryable = RETRYABLE_MARKERS.some((m) => marker.includes(m));
      if (!retryable) throw err;

      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }
}

interface GasPriceFetcherOptions {
  /** Cache TTL for a resolved gas price (ms). */
  ttlMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Memoized gas-price fetch: short TTL cache + single shared in-flight promise.
 *
 * - Concurrent callers while a fetch is in flight all receive the SAME
 *   promise, so N publishes fire exactly ONE Pimlico request.
 * - A resolved value is reused within `ttlMs`.
 * - Failures clear the in-flight slot (so the next caller retries) and are
 *   retried with backoff before surfacing.
 */
export function createGasPriceFetcher(
  fetchFn: () => Promise<GasPriceResult> | GasPriceResult,
  opts: GasPriceFetcherOptions = {},
): () => Promise<GasPriceResult> {
  const { ttlMs = 10_000, retries = 3, baseDelayMs = 250, maxDelayMs = 5000 } =
    opts;

  let cached: { value: GasPriceResult; expiresAt: number } | undefined;
  let inFlight: Promise<GasPriceResult> | undefined;

  const fetchFresh = () =>
    withRetryBackoff(fetchFn, { retries, baseDelayMs, maxDelayMs })
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });

  return () => {
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    inFlight ??= fetchFresh();
    return inFlight;
  };
}
