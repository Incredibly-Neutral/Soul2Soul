/**
 * Unit tests for isRevokedByDealState — the conservative on-chain revoke
 * guard in render/main.ts (reviewer C/G).
 *
 * The guard must only mark GENUINELY-revoked items as revoked:
 *   - hasDeal definitively false → revoked (true)
 *   - hasDeal true (live deal) → not revoked (false)
 *   - RPC failure → NOT revoked (false) — a transport error must never turn a
 *     live page into a revoked-and-removed one; runRenderActionWithRetry
 *     handles transient RPC failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRevokedByDealState } from './main';
import { evmRead } from '../libs/evm';

vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: vi.fn(),
}));

const JOB_ID = '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063';
const PUBLICATION_MODULE = '0xpub';
const RPCS = ['https://rpc.l2'];

describe('isRevokedByDealState — conservative revoke guard (reviewer C/G)', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockReset();
  });

  it('returns true when hasDeal is definitively false (genuine revoke)', async () => {
    vi.mocked(evmRead).mockResolvedValue(false);
    expect(await isRevokedByDealState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(true);
  });

  it('returns false when hasDeal is true (live deal)', async () => {
    vi.mocked(evmRead).mockResolvedValue(true);
    expect(await isRevokedByDealState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(false);
  });

  it('returns false on RPC failure — a transport error never marks a live page revoked', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('rpc down'));
    expect(await isRevokedByDealState(JOB_ID, PUBLICATION_MODULE, RPCS)).toBe(false);
  });
});
