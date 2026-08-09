import { describe, it, expect, vi } from 'vitest';
import { FilecoinMinCopiesError, uploadWithMinCopies } from './index';

const ALL_PROVIDERS = [1n, 13n, 15n, 16n, 29n, 30n, 32n];

describe('uploadWithMinCopies', () => {
  it('returns the result on the first attempt when two copies are committed', async () => {
    const attempt = vi.fn(async (pair: bigint[]) => ({
      complete: true,
      failedProviders: [],
      result: { ok: true, pair },
    }));

    const res = await uploadWithMinCopies(ALL_PROVIDERS, 2, attempt);

    expect(res).toEqual({ ok: true, pair: [1n, 13n] });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenNthCalledWith(1, [1n, 13n]);
  });

  it('retries with the next pair, excluding a failed primary, until two copies are committed', async () => {
    const attempt = vi.fn(async (pair: bigint[]) => {
      if (pair[0] === 1n) {
        // primary 1n fails to store -> excluded, retry with next pair
        return { complete: false, failedProviders: [1n] };
      }
      return { complete: true, failedProviders: [], result: { ok: true, pair } };
    });

    const res = await uploadWithMinCopies(ALL_PROVIDERS, 2, attempt);

    expect(res).toEqual({ ok: true, pair: [13n, 15n] });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, [1n, 13n]);
    expect(attempt).toHaveBeenNthCalledWith(2, [13n, 15n]);
  });

  it('excludes partial failures (secondary failed copies) on the next attempt', async () => {
    // First pair [1n, 13n]: primary commits but the secondary 13n failed to
    // pull (complete=false, failedProviders=[13n]). Next pair must be [1n, 15n].
    const attempt = vi.fn(async (pair: bigint[]) => {
      if (pair[0] === 1n && pair[1] === 13n) {
        return { complete: false, failedProviders: [13n] };
      }
      return { complete: true, failedProviders: [], result: { ok: true, pair } };
    });

    const res = await uploadWithMinCopies(ALL_PROVIDERS, 2, attempt);

    expect(res).toEqual({ ok: true, pair: [1n, 15n] });
  });

  it('excludes a reported-failed provider from all later attempts', async () => {
    const attempt = vi.fn(async (pair: bigint[]) => {
      if (pair[0] === 1n) {
        return { complete: false, failedProviders: [1n] };
      }
      return { complete: true, failedProviders: [], result: { ok: true, pair } };
    });

    const res = await uploadWithMinCopies([1n, 13n, 15n, 16n], 2, attempt);

    expect(res).toEqual({ ok: true, pair: [13n, 15n] });
    expect(attempt).toHaveBeenCalledTimes(2);
    // 1n was reported failed on the first attempt and must never appear again
    for (const call of attempt.mock.calls.slice(1)) {
      expect(call[0]).not.toContain(1n);
    }
  });

  it('throws FilecoinMinCopiesError with a single concise line when the pool is exhausted', async () => {
    const attempt = vi.fn(async (pair: bigint[]) => ({
      complete: false,
      failedProviders: pair, // every attempted provider fails
    }));

    await expect(uploadWithMinCopies([1n, 13n, 15n], 2, attempt)).rejects.toThrow(
      FilecoinMinCopiesError,
    );

    try {
      await uploadWithMinCopies([1n, 13n, 15n], 2, attempt);
      expect.unreachable('uploadWithMinCopies should have thrown');
    } catch (e) {
      const err = e as FilecoinMinCopiesError;
      expect(err.name).toBe('FilecoinMinCopiesError');
      // 1n+13n fail together, leaving only 15n (<2) — so only 1 and 13 are attempted
      expect(err.providers).toEqual(['1', '13']);
      expect(err.message).toBe('could not store 2 Filecoin copies (providers attempted: 1, 13)');
      // message must be a single line — no nested cause chain
      expect(err.message.split('\n')).toHaveLength(1);
    }
  });
});
