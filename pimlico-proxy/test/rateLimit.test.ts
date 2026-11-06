import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createRateLimiter } from '../src/rateLimit.js'

const WINDOW = 60_000
const T0 = 1_700_000_000_000

describe('createRateLimiter', () => {
  test('allows the first call and reports the remaining budget', () => {
    const limiter = createRateLimiter(3)

    const decision = limiter.check('user-a', T0)

    assert.deepEqual(decision, { allowed: true, remaining: 2, retryAfterSeconds: 0 })
  })

  test('decrements remaining on each allowed call', () => {
    const limiter = createRateLimiter(3)

    assert.equal(limiter.check('user-a', T0).remaining, 2)
    assert.equal(limiter.check('user-a', T0 + 1).remaining, 1)
    assert.equal(limiter.check('user-a', T0 + 2).remaining, 0)
  })

  test('rejects the call past the limit with a retryAfterSeconds in range', () => {
    const limiter = createRateLimiter(3)

    limiter.check('user-a', T0)
    limiter.check('user-a', T0)
    limiter.check('user-a', T0)

    const decision = limiter.check('user-a', T0)

    assert.equal(decision.allowed, false)
    assert.equal(decision.remaining, 0)
    assert.ok(decision.retryAfterSeconds >= 1)
    assert.ok(decision.retryAfterSeconds <= WINDOW / 1000)
    assert.equal(decision.retryAfterSeconds, 60)
  })

  test('rounds retryAfterSeconds up near the end of the window', () => {
    const limiter = createRateLimiter(1, 10_000)

    limiter.check('user-a', T0)
    const decision = limiter.check('user-a', T0 + 9_500)

    assert.equal(decision.allowed, false)
    // 500ms left of the window -> one whole second.
    assert.equal(decision.retryAfterSeconds, 1)
  })

  test('a rejected call does not reset the window and stays rejected', () => {
    const limiter = createRateLimiter(1, 10_000)

    assert.equal(limiter.check('user-a', T0).allowed, true)
    assert.equal(limiter.check('user-a', T0 + 5_000).allowed, false)
    // If the rejected call had started a fresh window, this would be allowed.
    assert.equal(limiter.check('user-a', T0 + 9_999).allowed, false)
  })

  test('a rejected call keeps counting into the same window', () => {
    const limiter = createRateLimiter(1, 10_000)

    limiter.check('user-a', T0)
    const firstRejection = limiter.check('user-a', T0 + 1_000)
    const secondRejection = limiter.check('user-a', T0 + 2_000)

    assert.deepEqual(firstRejection, {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 9,
    })
    assert.deepEqual(secondRejection, {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 8,
    })
  })

  test('rolls over exactly when now reaches windowStart + windowMs', () => {
    const limiter = createRateLimiter(2)

    limiter.check('user-a', T0)
    limiter.check('user-a', T0 + 1_000)
    assert.equal(limiter.check('user-a', T0 + 59_999).allowed, false)

    const rolled = limiter.check('user-a', T0 + WINDOW)

    assert.deepEqual(rolled, { allowed: true, remaining: 1, retryAfterSeconds: 0 })
  })

  test('tracks separate keys independently', () => {
    const limiter = createRateLimiter(1)

    assert.equal(limiter.check('user-a', T0).allowed, true)
    assert.equal(limiter.check('user-a', T0).allowed, false)

    assert.deepEqual(limiter.check('user-b', T0), {
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    })
    assert.equal(limiter.size, 2)
  })

  describe('sweep', () => {
    test('removes only expired entries and keeps size consistent', () => {
      const limiter = createRateLimiter(5, 1_000)

      limiter.check('early', T0)
      limiter.check('late', T0 + 500)
      assert.equal(limiter.size, 2)

      limiter.sweep(T0 + 999)
      assert.equal(limiter.size, 2)

      limiter.sweep(T0 + 1_000)
      assert.equal(limiter.size, 1)

      // The surviving key still has its window, so its count keeps climbing.
      assert.equal(limiter.check('late', T0 + 1_000).remaining, 3)

      limiter.sweep(T0 + 1_500)
      assert.equal(limiter.size, 0)
    })

    test('an expired entry that is checked again starts a fresh window', () => {
      const limiter = createRateLimiter(1, 1_000)

      limiter.check('user-a', T0)
      limiter.sweep(T0 + 1_000)
      assert.equal(limiter.size, 0)

      assert.equal(limiter.check('user-a', T0 + 1_000).allowed, true)
      assert.equal(limiter.size, 1)
    })
  })

  describe('validation', () => {
    test('rejects a non-positive or non-integer limit', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => createRateLimiter(bad), RangeError)
      }
    })

    test('rejects a non-positive or non-finite window', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => createRateLimiter(1, bad), RangeError)
      }
    })

    test('accepts a positive window and defaults to one minute', () => {
      const explicit = createRateLimiter(1, 1_000)
      explicit.check('user-a', T0)
      assert.equal(explicit.check('user-a', T0 + 999).allowed, false)
      assert.equal(explicit.check('user-a', T0 + 1_000).allowed, true)

      const defaulted = createRateLimiter(1)
      defaulted.check('user-a', T0)
      assert.equal(defaulted.check('user-a', T0 + 59_999).allowed, false)
      assert.equal(defaulted.check('user-a', T0 + 60_000).allowed, true)
    })
  })

  test('never returns a negative retryAfterSeconds', () => {
    const limiter = createRateLimiter(1, 1_000)

    limiter.check('user-a', T0)
    const decision = limiter.check('user-a', T0 + 999)

    assert.equal(decision.allowed, false)
    assert.ok(decision.retryAfterSeconds >= 0)
    assert.equal(decision.retryAfterSeconds, 1)
  })
})
