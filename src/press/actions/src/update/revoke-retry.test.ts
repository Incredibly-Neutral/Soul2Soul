/**
 * Retry tests — `verifyRevocable` (update/verify.ts).
 *
 * A revoke retracts on-chain immediately before the update, and a replica that
 * has not caught up still answers "in force". The page at the MFS path cannot
 * have changed in that window, so the retry must re-ask the CHAIN only: one
 * `files/read` for the page, then `hasAgreement` until it answers or the
 * attempts run out — and every retry must reach the chain, not the session's
 * read cache, which is what remembered the stale answer.
 *
 * `isOutOfForce` (first attempt, cached) and `readFresh` (retries) are mocked —
 * they are the two questions under test; everything else in verify.ts is real,
 * against a stubbed gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ethers from 'ethers5';

// verify.ts references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5.
(globalThis as { ethers?: unknown }).ethers = ethers;

const mocks = vi.hoisted(() => ({
  /**
   * Is the genesis in force, for successive asks. Both lists speak the same
   * language — the question the caller cares about — even though the two paths
   * get their answer from different functions. The last entry repeats.
   */
  cached: [] as boolean[],
  /** The same for the retries, which read the chain through `readFresh`. */
  fresh: [] as Array<boolean | Error>,
  cachedCalls: 0,
  freshCalls: [] as Array<{ chain: string; target: string; fn: string; args: unknown[] }>,
  gatewayUrls: [] as string[],
  /** The body `files/read` answers with (a page carrying an identifier). */
  pageBody: '<script type="application/ld+json">{"identifier":"existing-genesis"}</script>',
  readStatus: 200,
}));

vi.mock('../libs/gates', () => ({
  // `isOutOfForce` answers the caller's question: true = out of force.
  isOutOfForce: vi.fn(async () => {
    mocks.cachedCalls += 1;
    const inForce = mocks.cached.length > 1 ? mocks.cached.shift()! : mocks.cached[0];
    return !inForce;
  }),
}));

vi.mock('../libs/evm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/evm')>();
  return {
    ...actual,
    readFresh: vi.fn(
      async (chain: string, target: string, _abi: unknown, fn: string, args: unknown[]) => {
        mocks.freshCalls.push({ chain, target, fn, args });
        const inForce = mocks.fresh.length > 1 ? mocks.fresh.shift()! : mocks.fresh[0];
        if (inForce instanceof Error) throw inForce;
        // `readFresh` is the raw read: `hasAgreement` is true while in force.
        return inForce;
      },
    ),
  };
});

import { verifyRevocable } from './verify';

const gateway = 'http://gateway.test';
const PUB_MODULE = '0x' + '44'.repeat(20);

const readCalls = (): number => mocks.gatewayUrls.filter((u) => u.includes('files/read')).length;

beforeEach(() => {
  mocks.cached = [true];
  mocks.fresh = [true];
  mocks.cachedCalls = 0;
  mocks.freshCalls = [];
  mocks.gatewayUrls = [];
  mocks.pageBody = '<script type="application/ld+json">{"identifier":"existing-genesis"}</script>';
  mocks.readStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      mocks.gatewayUrls.push(url);
      if (url.includes('files/read')) {
        return mocks.readStatus === 200
          ? new Response(mocks.pageBody, { status: 200 })
          : new Response('no such file', { status: mocks.readStatus });
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('verifyRevocable — one page read, the chain question retried', () => {
  it('the first ask takes the cached read, the retries go to the chain', async () => {
    mocks.cached = [true]; // still in force on the cached answer
    mocks.fresh = [true, false]; // the replica catches up on the second ask

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).resolves.toBeUndefined();

    expect(readCalls()).toBe(1);
    // One cached ask, then two that bypassed the cache until the chain said so.
    expect(mocks.cachedCalls).toBe(1);
    expect(mocks.freshCalls.length).toBe(2);
    // The same page, the same genesis, asked twice without re-reading the page.
    for (const call of mocks.freshCalls) {
      expect(call.chain).toBe('L2');
      expect(call.target).toBe(PUB_MODULE);
      expect(call.fn).toBe('hasAgreement');
      expect(call.args.length).toBe(1);
    }
    expect(new Set(mocks.freshCalls.map((c) => JSON.stringify(c.args))).size).toBe(1);
  });

  it('gives up after the attempt budget with the refusal wording the trace keeps', async () => {
    mocks.cached = [true];
    mocks.fresh = [true];

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).rejects.toThrow('Refusing to remove: genesis');

    expect(readCalls()).toBe(1);
    expect(mocks.cachedCalls).toBe(1);
    expect(mocks.freshCalls.length).toBe(2);
  });

  it('a cached answer already out of force costs no chain ask at all', async () => {
    mocks.cached = [false]; // out of force: the first ask settles it

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).resolves.toBeUndefined();

    expect(mocks.cachedCalls).toBe(1);
    expect(mocks.freshCalls).toEqual([]);
  });

  it('defaults to a single attempt — no retry, no fresh ask', async () => {
    mocks.cached = [true]; // in force

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2']),
    ).rejects.toThrow('still in force');

    expect(mocks.cachedCalls).toBe(1);
    expect(mocks.freshCalls).toEqual([]);
  });

  it('a fresh read that fails is in force, never a permission', async () => {
    mocks.cached = [true]; // in force
    mocks.fresh = [new Error('rpc down')];

    // The gate's rule, kept on the retry path: a transport error must not make
    // a live page look removable, so the refusal is what surfaces.
    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 2, 0),
    ).rejects.toThrow('still in force');

    expect(mocks.freshCalls.length).toBe(1);
  });

  it('a page read that fails is not retried', async () => {
    mocks.readStatus = 500;

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).rejects.toThrow('Failed to read MFS path');

    expect(readCalls()).toBe(1);
    expect(mocks.cachedCalls).toBe(0);
    expect(mocks.freshCalls).toEqual([]);
  });
});
