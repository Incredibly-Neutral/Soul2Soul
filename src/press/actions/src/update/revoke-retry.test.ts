/**
 * Retry tests — `verifyRevocable` (update/verify.ts).
 *
 * A revoke retracts on-chain immediately before the update, and a replica that
 * has not caught up still answers "in force". The page at the MFS path cannot
 * have changed in that window, so the retry must re-ask the CHAIN only: one
 * `files/read` for the page, then `isOutOfForce` until it answers or the
 * attempts run out. A read failure is not retried — it fails at once.
 *
 * `isOutOfForce` is mocked (it is the chain question under test); everything
 * else in verify.ts is real, against a stubbed gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ethers from 'ethers5';

// verify.ts references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5.
(globalThis as { ethers?: unknown }).ethers = ethers;

const mocks = vi.hoisted(() => ({
  /** Answers for successive `isOutOfForce` calls; the last one repeats. */
  answers: [] as Array<boolean | Error>,
  calls: [] as string[],
  gatewayUrls: [] as string[],
  /** The body `files/read` answers with (a page carrying an identifier). */
  pageBody: '<script type="application/ld+json">{"identifier":"existing-genesis"}</script>',
  readStatus: 200,
}));

vi.mock('../libs/gates', () => ({
  isOutOfForce: vi.fn(async (genesis: string) => {
    mocks.calls.push(genesis);
    const answer = mocks.answers.length > 1 ? mocks.answers.shift()! : mocks.answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  }),
}));

import { verifyRevocable } from './verify';

const gateway = 'http://gateway.test';
const PUB_MODULE = '0x' + '44'.repeat(20);

const argsOf = (url: string): string[] =>
  (url.split('?')[1] ?? '')
    .split('&')
    .filter((p) => p.startsWith('arg='))
    .map((p) => decodeURIComponent(p.slice('arg='.length)));

const readCalls = (): number => mocks.gatewayUrls.filter((u) => u.includes('files/read')).length;

beforeEach(() => {
  mocks.answers = [true];
  mocks.calls = [];
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
  it('retries until the chain says out of force, reading the page once', async () => {
    mocks.answers = [false, false, true];

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).resolves.toBeUndefined();

    expect(readCalls()).toBe(1);
    expect(mocks.calls.length).toBe(3);
    // The same bytes were asked about every time: one page, one hash source.
    expect(new Set(mocks.calls).size).toBe(1);
  });

  it('gives up after the attempt budget with the refusal wording the trace keeps', async () => {
    mocks.answers = [false];

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).rejects.toThrow('Refusing to remove: genesis');

    expect(readCalls()).toBe(1);
    expect(mocks.calls.length).toBe(3);
  });

  it('defaults to a single attempt — no retry, no extra chain call', async () => {
    mocks.answers = [false];

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2']),
    ).rejects.toThrow('still in force');

    expect(mocks.calls.length).toBe(1);
  });

  it('a page read that fails is not retried', async () => {
    mocks.readStatus = 500;

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).rejects.toThrow('Failed to read MFS path');

    expect(readCalls()).toBe(1);
    expect(mocks.calls).toEqual([]);
  });

  it('a chain read that throws is not swallowed and is not retried', async () => {
    mocks.answers = [new Error('rpc down')];

    await expect(
      verifyRevocable(gateway, '/root', 'some/page', PUB_MODULE, ['http://rpc.l2'], 3, 0),
    ).rejects.toThrow('rpc down');

    expect(mocks.calls.length).toBe(1);
  });
});
