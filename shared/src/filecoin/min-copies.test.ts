import { describe, it, expect, vi } from 'vitest';
import {
  FilecoinMinCopiesError,
  uploadWithMinCopies,
  type MinCopiesAttempt,
} from './index';

// Mirrors BROWSER_USABLE_PROVIDERS after hygiene: four primary-usable
// providers, each usable as an INDEPENDENT PRIMARY (h2 + upload CORS).
const ALL_PROVIDERS = [6n, 13n, 15n, 29n];

/** A successful independent primary-store attempt (one committed copy). */
function committedCopy(id: bigint): MinCopiesAttempt {
  return {
    committed: true,
    failedProviders: [],
    copy: { provider: id.toString(), dealId: `d${id}` },
  };
}

describe('uploadWithMinCopies (two independent primary stores)', () => {
  it('returns exactly 2 committed copies when exactly 2 providers succeed as primaries', async () => {
    const attempt = vi.fn(async (p: bigint): Promise<MinCopiesAttempt> => committedCopy(p));

    const res = await uploadWithMinCopies(ALL_PROVIDERS, 2, attempt);

    // Exactly two copies, from the first two independent primaries.
    expect(res).toEqual([
      { provider: '6', dealId: 'd6' },
      { provider: '13', dealId: 'd13' },
    ]);
    // One call per primary; stops as soon as 2 copies are committed.
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 6n);
    expect(attempt).toHaveBeenNthCalledWith(2, 13n);
  });

  it('excludes a failed primary and continues to the next until 2 copies commit', async () => {
    const attempt = vi.fn(async (p: bigint): Promise<MinCopiesAttempt> => {
      if (p === 6n) return { committed: false, failedProviders: [6n] };
      return committedCopy(p);
    });

    const res = await uploadWithMinCopies(ALL_PROVIDERS, 2, attempt);

    expect(res).toEqual([
      { provider: '13', dealId: 'd13' },
      { provider: '15', dealId: 'd15' },
    ]);
    // 6n fails, then 13n and 15n commit — three independent stores attempted.
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(attempt).toHaveBeenNthCalledWith(1, 6n);
    expect(attempt).toHaveBeenNthCalledWith(2, 13n);
    expect(attempt).toHaveBeenNthCalledWith(3, 15n);
    // The failed primary must never be re-attempted.
    for (const call of attempt.mock.calls.slice(1)) {
      expect(call[0]).not.toBe(6n);
    }
  });

  it('a provider that reports no committed copy (no-progress) is excluded and does not count', async () => {
    // First provider comes back committed:false with no failedProviders — the
    // SDK threw a store error with no provider id. The whole attempted set
    // (just this provider) must be dropped so we move on.
    const attempt = vi.fn(async (p: bigint): Promise<MinCopiesAttempt> => {
      if (p === 6n) return { committed: false, failedProviders: [] };
      return committedCopy(p);
    });

    const res = await uploadWithMinCopies([6n, 13n, 15n], 2, attempt);

    expect(res).toEqual([
      { provider: '13', dealId: 'd13' },
      { provider: '15', dealId: 'd15' },
    ]);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('throws FilecoinMinCopiesError (single concise line) when the pool is exhausted', async () => {
    const attempt = vi.fn(
      async (p: bigint): Promise<MinCopiesAttempt> => ({ committed: false, failedProviders: [p] }),
    );

    await expect(uploadWithMinCopies([6n, 13n, 15n], 2, attempt)).rejects.toThrow(
      FilecoinMinCopiesError,
    );

    try {
      await uploadWithMinCopies([6n, 13n, 15n], 2, attempt);
      expect.unreachable('uploadWithMinCopies should have thrown');
    } catch (e) {
      const err = e as FilecoinMinCopiesError;
      expect(err.name).toBe('FilecoinMinCopiesError');
      expect(err.providers).toEqual(['6', '13', '15']);
      expect(err.message).toBe('could not store 2 Filecoin copies (providers attempted: 6, 13, 15)');
      // message must be a single line — no nested cause chain
      expect(err.message.split('\n')).toHaveLength(1);
    }
  });

  it('terminates (no infinite loop) on a no-progress attempt — whole attempted set dropped each round', async () => {
    // `attempt` fails with NO provider id (empty `failedProviders`) on every
    // call — e.g. a StoreError without providerId, a context-resolution /
    // createContexts failure, or a UserRejectedRequestError. The attempted
    // provider must be dropped every round so the pool strictly shrinks and
    // the loop is guaranteed to terminate instead of re-attempting forever.
    const attempt = vi.fn(
      async (_p: bigint): Promise<MinCopiesAttempt> => ({ committed: false, failedProviders: [] }),
    );

    await expect(uploadWithMinCopies([6n, 13n, 15n, 29n], 2, attempt)).rejects.toThrow(
      FilecoinMinCopiesError,
    );

    // Each provider attempted exactly once, in order — none ever repeated.
    expect(attempt.mock.calls.map((c) => c[0])).toEqual([6n, 13n, 15n, 29n]);

    try {
      await uploadWithMinCopies([6n, 13n, 15n, 29n], 2, attempt);
      expect.unreachable('uploadWithMinCopies should have thrown');
    } catch (e) {
      const err = e as FilecoinMinCopiesError;
      expect(err.name).toBe('FilecoinMinCopiesError');
      expect(err.providers).toEqual(['6', '13', '15', '29']);
      expect(err.message).toBe(
        'could not store 2 Filecoin copies (providers attempted: 6, 13, 15, 29)',
      );
      expect(err.message.split('\n')).toHaveLength(1);
    }
  });
});
