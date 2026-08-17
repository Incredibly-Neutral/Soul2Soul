/**
 * Unit tests for the Pimlico gas-price resilience helpers
 * (src/eth/pimlico.gas.ts):
 *
 *   - createGasPriceFetcher: short-TTL cache + in-flight dedupe (N concurrent
 *     callers fire ONE upstream request)
 *   - withRetryBackoff: exponential backoff + jitter on transport/timeout
 *     failures, no retry on non-retryable errors
 *   - warmUpPimlico: best-effort, never throws
 *
 * These are pure helpers — no network, no env vars required.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createGasPriceFetcher,
  withRetryBackoff,
  warmUpPimlico,
  GasPriceResult,
} from '../src/eth/pimlico.gas.js';

const makeGasPrice = (n: number): GasPriceResult => ({
  slow: { maxFeePerGas: BigInt(n), maxPriorityFeePerGas: BigInt(n) },
  standard: { maxFeePerGas: BigInt(n), maxPriorityFeePerGas: BigInt(n) },
  fast: { maxFeePerGas: BigInt(n), maxPriorityFeePerGas: BigInt(n) },
});

const timeoutError = () =>
  new Error('TimeoutError: The request took too long to respond');

describe('createGasPriceFetcher', () => {
  it('dedupes concurrent calls into a single upstream request', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(makeGasPrice(1)));
    const get = createGasPriceFetcher(fetchFn, { ttlMs: 10_000 });

    const [a, b, c] = await Promise.all([get(), get(), get()]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a.fast.maxFeePerGas).toBe(1n);
    expect(b.fast.maxFeePerGas).toBe(1n);
    expect(c.fast.maxFeePerGas).toBe(1n);
  });

  it('serves a cached value within the TTL without re-fetching', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(makeGasPrice(1)));
    const get = createGasPriceFetcher(fetchFn, { ttlMs: 10_000 });

    await get();
    await get();
    await get();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(makeGasPrice(1)));
    const get = createGasPriceFetcher(fetchFn, { ttlMs: 5 });

    await get();
    // Wait past the TTL, then fetch again — must hit upstream once more.
    await new Promise((r) => setTimeout(r, 15));
    await get();

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries a transient timeout and returns the recovered value', async () => {
    let calls = 0;
    const fetchFn = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(timeoutError());
      return Promise.resolve(makeGasPrice(7));
    });
    const get = createGasPriceFetcher(fetchFn, {
      ttlMs: 10_000,
      retries: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });

    const price = await get();
    expect(price.fast.maxFeePerGas).toBe(7n);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot on failure so the next caller retries', async () => {
    const fetchFn = vi.fn(() => Promise.reject(timeoutError()));
    const get = createGasPriceFetcher(fetchFn, {
      retries: 0,
    });

    await expect(get()).rejects.toThrow();
    // After the failed attempt settles, a new call starts a fresh upstream request.
    await expect(get()).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetryBackoff', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const fn = vi.fn(() => 'ok');
    expect(await withRetryBackoff(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient timeout and eventually succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls <= 2) throw timeoutError();
      return 'ok';
    });
    expect(await withRetryBackoff(fn, { baseDelayMs: 1, maxDelayMs: 5 })).toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn(() => {
      throw timeoutError();
    });
    await expect(
      withRetryBackoff(fn, { retries: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toThrow(/took too long/);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(() => {
      throw new Error('revert: insufficient funds');
    });
    await expect(withRetryBackoff(fn)).rejects.toThrow(/insufficient funds/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('warmUpPimlico', () => {
  it('is best-effort: never throws even when the client rejects', async () => {
    const client = {
      request: vi.fn(() => Promise.reject(timeoutError())),
    };
    // Should not throw synchronously or reject the returned promise.
    expect(() => {
      warmUpPimlico(client);
    }).not.toThrow();
    // Give the fire-and-forget promise a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
  });

  it('issues a no-op eth_chainId request', async () => {
    const client = {
      request: vi.fn(() => Promise.resolve('0x2105')),
    };
    warmUpPimlico(client);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.request).toHaveBeenCalledWith({ method: 'eth_chainId' });
  });

  it('no-ops on a client without request', () => {
    expect(() => {
      warmUpPimlico(undefined);
    }).not.toThrow();
    expect(() => {
      warmUpPimlico({} as never);
    }).not.toThrow();
  });
});
