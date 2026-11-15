/**
 * `getPublicationFactory` — the one `publication_factory` record read.
 *
 * The helper exists so an action can predict the publication module before its
 * authorization gate without paying the protocol walk: one eth_call at the
 * records module, and null on every failure so the caller falls back to the
 * probes it ran before. Those three answers (a value, an empty record, a
 * reverting read) are what this file pins, together with the address the read
 * targets being the protocol's records module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  answer: '' as string,
}));

vi.mock('./evm', () => ({
  evmRead: vi.fn(async () => {
    if (mocks.answer === 'revert') throw new Error('execution reverted');
    return mocks.answer;
  }),
}));

import { evmRead } from './evm';
import { getPublicationFactory } from './protocol.factory';

const RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';
const FACTORY = '0x' + '77'.repeat(20);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.answer = '';
});

describe('getPublicationFactory', () => {
  it('returns the record and asks the records module for it in one call', async () => {
    mocks.answer = FACTORY;

    const factory = await getPublicationFactory();

    expect(factory).toBe(FACTORY);
    expect(evmRead).toHaveBeenCalledTimes(1);
    const [chain, address, , method, args] = vi.mocked(evmRead).mock.calls[0];
    expect(chain).toBe('L2');
    expect(address).toBe(RECORDS_MODULE);
    expect(method).toBe('getRecord');
    expect(args).toEqual(['publication_factory']);
  });

  it('returns null for an empty record, which is what an unwritten key answers', async () => {
    mocks.answer = '';

    expect(await getPublicationFactory()).toBeNull();
    expect(evmRead).toHaveBeenCalledTimes(1);
  });

  it('returns null when the read reverts, and does not retry', async () => {
    mocks.answer = 'revert';

    expect(await getPublicationFactory()).toBeNull();
    expect(evmRead).toHaveBeenCalledTimes(1);
  });

  it('passes the caller’s RPC URLs through to the read', async () => {
    mocks.answer = FACTORY;
    const rpcs = { L1: ['http://l1'], L2: ['http://l2'] };

    await getPublicationFactory(rpcs);

    expect(vi.mocked(evmRead).mock.calls[0][5]).toEqual(rpcs.L2);
  });
});
