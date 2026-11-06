/**
 * Fixed-window, in-process rate limiter.
 *
 * One counter per key. State lives in this process only: a second instance,
 * a restart, or a second replica starts from zero. That is a deliberate
 * limitation, not an oversight. If the service ever needs a shared budget,
 * the limiter has to move behind Redis; nothing here is designed to scale out.
 */

export type RateLimitDecision = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export type RateLimiter = {
  check(key: string, now?: number): RateLimitDecision
  sweep(now?: number): void
  readonly size: number
}

type WindowEntry = {
  windowStart: number
  count: number
}

const DEFAULT_WINDOW_MS = 60_000

/**
 * Build a limiter that allows `limitPerMinute` calls per key in each
 * `windowMs` window (default one minute).
 *
 * `now` is milliseconds since epoch everywhere, so tests can pass a clock
 * instead of faking timers.
 */
export function createRateLimiter(limitPerMinute: number, windowMs?: number): RateLimiter {
  if (!Number.isInteger(limitPerMinute) || limitPerMinute <= 0) {
    throw new RangeError(`limitPerMinute must be a positive integer, got ${String(limitPerMinute)}`)
  }

  const window = windowMs ?? DEFAULT_WINDOW_MS
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    throw new RangeError(`windowMs must be a positive number, got ${String(window)}`)
  }

  const entries = new Map<string, WindowEntry>()

  const isExpired = (entry: WindowEntry, now: number): boolean => now - entry.windowStart >= window

  const retryAfterSeconds = (windowStart: number, now: number): number => {
    const remainingMs = windowStart + window - now
    return Math.max(0, Math.ceil(remainingMs / 1000))
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitDecision {
      const existing = entries.get(key)

      if (existing === undefined || isExpired(existing, now)) {
        const entry: WindowEntry = { windowStart: now, count: 1 }
        entries.set(key, entry)
        return {
          allowed: true,
          remaining: Math.max(0, limitPerMinute - 1),
          retryAfterSeconds: 0,
        }
      }

      existing.count += 1
      const allowed = existing.count <= limitPerMinute

      return {
        allowed,
        remaining: Math.max(0, limitPerMinute - existing.count),
        retryAfterSeconds: allowed ? 0 : retryAfterSeconds(existing.windowStart, now),
      }
    },

    sweep(now: number = Date.now()): void {
      for (const [key, entry] of entries) {
        if (isExpired(entry, now)) {
          entries.delete(key)
        }
      }
    },

    get size(): number {
      return entries.size
    },
  }
}
