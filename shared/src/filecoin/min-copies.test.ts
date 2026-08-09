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

  it('does not re-attempt the same pair when an attempt fails with no provider id (whole pair excluded), then throws on pool exhaustion', async () => {
    // `attempt` fails with NO provider id (empty `failedProviders`) on every
    // call — e.g. a StoreError without providerId, a context-resolution /
    // createContexts failure, or a UserRejectedRequestError that propagates as
    // an error carrying no provider id. Before the fix this re-formed the
    // identical pair forever; now the whole pair is excluded each round so the
    // pool strictly shrinks and the function must terminate.
    const attempt = vi.fn(async (pair: bigint[]) => ({
      complete: false,
      failedProviders: [], // no provider identified
    }));

    await expect(uploadWithMinCopies([1n, 13n, 15n, 16n], 2, attempt)).rejects.toThrow(
      FilecoinMinCopiesError,
    );

    // Pair 1 [1n,13n] and pair 2 [15n,16n] are attempted, then the pool is
    // empty (<2) and it throws. No provider is ever re-attempted.
    expect(attempt.mock.calls).toEqual([[[1n, 13n]], [[15n, 16n]]]);
    const seen: string[] = [];
    for (const call of attempt.mock.calls) {
      seen.push(...(call[0] as bigint[]).map((id) => id.toString()));
    }
    expect(new Set(seen).size).toBe(seen.length); // no provider repeated

    try {
      await uploadWithMinCopies([1n, 13n, 15n, 16n], 2, attempt);
      expect.unreachable('uploadWithMinCopies should have thrown');
    } catch (e) {
      const err = e as FilecoinMinCopiesError;
      expect(err.name).toBe('FilecoinMinCopiesError');
      expect(err.providers).toEqual(['1', '13', '15', '16']);
      expect(err.message).toBe('could not store 2 Filecoin copies (providers attempted: 1, 13, 15, 16)');
      // message must be a single line — no nested cause chain
      expect(err.message.split('\n')).toHaveLength(1);
    }
  });
});
