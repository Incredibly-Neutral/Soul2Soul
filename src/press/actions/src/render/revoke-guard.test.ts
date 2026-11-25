/**
 * Unit tests for isRevokedByAgreementState — the conservative on-chain revoke
 * guard in render/main.ts (reviewer C/G).
 *
 * A publish run asks only hasAgreement:
 *   - hasAgreement definitively false → revoked (true)
 *   - hasAgreement true (live agreement) → not revoked (false)
 *   - RPC failure → NOT revoked (false) — a transport error must never turn a
 *     live page into a revoked-and-removed one; runRenderActionWithRetry
 *     handles transient RPC failures.
 *
 * A preview run asks the module's own canRead(genesis, safe), one atomic view:
 *   - canRead true (an agreement or an offer holds) → not revoked
 *   - canRead false → revoked, even when a separate hasOffer read would say true:
 *     the module's view is the authority, and hasOffer is never consulted
 *   - canRead (or the safe() read before it) failing → not revoked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRevokedByAgreementState } from './main';
import { evmRead } from '../libs/evm';

// render/main.ts imports ens.factory, which computes the two module kinds from
// the bundle's runtime `ethers` global at module load.
vi.hoisted(() => {
  (globalThis as any).ethers = {
    utils: {
      id: (text: string) =>
        text === 's2s.module.publication' ? '0x' + '93'.repeat(32) : '0x' + '32'.repeat(32),
      namehash: () => '0x' + 'ab'.repeat(32),
    },
  };
});

vi.mock('../libs/evm', () => ({
  enableReadCache: vi.fn(),
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: vi.fn(),
}));

const JOB_ID = '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063';
const PUBLICATION_MODULE = '0xpub';
const RPCS = ['https://rpc.l2'];

describe('isRevokedByAgreementState — conservative revoke guard (reviewer C/G)', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockReset();
  });

  it('returns true when hasAgreement is definitively false (genuine revoke)', async () => {
    vi.mocked(evmRead).mockResolvedValue(false);
    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(true);
  });

  it('returns false when hasAgreement is true (live deal)', async () => {
    vi.mocked(evmRead).mockResolvedValue(true);
    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(false);
  });

  it('returns false on RPC failure — a transport error never marks a live page revoked', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('rpc down'));
    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(false);
  });

  it('asks only hasAgreement in a publish run, even when an offer is open', async () => {
    vi.mocked(evmRead).mockImplementation(async (_chain, _target, _abi, fn) => fn === 'hasOffer');

    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(true);
    expect(vi.mocked(evmRead).mock.calls.map((c) => c[3])).toEqual(['hasAgreement']);
  });

  it('asks safe() then the module canRead in a preview, and answers not revoked when it admits', async () => {
    vi.mocked(evmRead).mockImplementation(async (_chain, _target, _abi, fn) =>
      fn === 'safe' ? '0xsafe' : true,
    );

    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS, true)).toBe(false);
    expect(vi.mocked(evmRead).mock.calls.map((c) => c[3])).toEqual(['safe', 'canRead']);
  });

  it('revokes in a preview when the module canRead says false, even if hasOffer would say true', async () => {
    vi.mocked(evmRead).mockImplementation(async (_chain, _target, _abi, fn) => {
      if (fn === 'safe') return '0xsafe';
      if (fn === 'hasOffer') return true;
      return false;
    });

    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS, true)).toBe(true);
    expect(vi.mocked(evmRead).mock.calls.map((c) => c[3])).toEqual(['safe', 'canRead']);
  });

  it('does not revoke in a preview when either read fails', async () => {
    vi.mocked(evmRead).mockImplementation(async (_chain, _target, _abi, fn) => {
      if (fn === 'canRead') throw new Error('canRead down');
      return '0xsafe';
    });
    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS, true)).toBe(false);

    vi.mocked(evmRead).mockImplementation(async (_chain, _target, _abi, fn) => {
      if (fn === 'safe') throw new Error('safe down');
      return false;
    });
    expect(await isRevokedByAgreementState(JOB_ID, PUBLICATION_MODULE, RPCS, true)).toBe(false);
  });
});
