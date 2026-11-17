/**
 * `getPublicationFactory` — the one `publication_factory` record read.
 *
 * The helper exists so an action can ask the factory which modules a Safe owns
 * before its authorization gate without paying the protocol walk: one eth_call
 * at the records module, and null on every failure. A null record is a failure
 * at every call site — module discovery has no other source — so the three
 * answers (a value, an empty record, a reverting read) are what this file pins,
 * together with the address the read targets being the records module.
 *
 * `getProtocolInfo` reuses that read: `moduleFactory` is the record discovery
 * was built from, `publicationFactory` the copy `configModule` publishes. A
 * caller that already holds the record passes it and spends no second read.
 *
 * The records themselves are read from `PROTOCOL_RECORDS_MODULE`, the constant,
 * not from a module discovered through the factory: that module is the protocol's
 * root and holds the record the factory address came from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  answer: '' as string,
  records: [] as any[],
}));

// ens.factory (imported through protocol.factory) computes the two module kinds
// from the bundle's runtime `ethers` global at module load.
vi.hoisted(() => {
  (globalThis as any).ethers = {
    utils: {
      id: (text: string) =>
        text === 's2s.module.publication' ? '0x' + '93'.repeat(32) : '0x' + '32'.repeat(32),
      namehash: () => '0x' + 'ab'.repeat(32),
    },
  };
});

vi.mock('./evm', () => ({
  evmRead: vi.fn(
    async (chain: string, address: string, abi: unknown, method: string, args: any[]) => {
      if (method === 'getRecord') {
        if (mocks.answer === 'revert') throw new Error('execution reverted');
        return mocks.answer;
      }
      if (method === 'getRecords') return mocks.records;
      return '';
    },
  ),
}));

import { evmRead } from './evm';
import { getProtocolInfo, getPublicationFactory } from './protocol.factory';

const RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';
const FACTORY = '0x' + '77'.repeat(20);
const PUB_RECORD = '0x' + '55'.repeat(20);

const recordReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'getRecord');
const recordsReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'getRecords');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.answer = '';
  mocks.records = [
    '0x' + '01'.repeat(20), // data_gateway
    '0x' + '02'.repeat(20), // ens_records
    '0x' + '03'.repeat(20), // ens_registry
    PUB_RECORD, // publication_factory
    '0x' + '04'.repeat(20), // records_factory
    '0x' + '05'.repeat(20), // pkp_ethAddress
    '0x' + '06'.repeat(20), // lit_action_prep
    '0x' + '07'.repeat(20), // lit_action_render
    '0x' + '08'.repeat(20), // lit_action_update
  ];
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

describe('getProtocolInfo', () => {
  it('returns the record discovery used as moduleFactory, beside the getRecords copy', async () => {
    mocks.answer = FACTORY;

    const info = await getProtocolInfo(false);

    expect(info.moduleFactory).toBe(FACTORY);
    expect(info.publicationFactory).toBe(PUB_RECORD);
  });

  it('reads the record once when no factory is passed', async () => {
    mocks.answer = FACTORY;

    await getProtocolInfo(false);

    expect(recordReads()).toHaveLength(1);
  });

  it('skips the standalone read when the caller passes the factory', async () => {
    const info = await getProtocolInfo(false, undefined, FACTORY);

    expect(recordReads()).toHaveLength(0);
    expect(info.moduleFactory).toBe(FACTORY);
  });

  it('reads the records module held as a constant, with no factory walk', async () => {
    mocks.answer = FACTORY;

    await getProtocolInfo(false);

    expect(recordsReads()).toHaveLength(1);
    expect(recordsReads()[0][1]).toBe(RECORDS_MODULE);
    // One getRecord for the factory, one getRecords for the rest: nothing else.
    expect(vi.mocked(evmRead).mock.calls).toHaveLength(2);
  });

  it('refuses a null factory without issuing a read', async () => {
    await expect(getProtocolInfo(false, undefined, null)).rejects.toThrow(
      'Failed to read the publication_factory record; module discovery needs it',
    );
    expect(recordReads()).toHaveLength(0);
  });
});
