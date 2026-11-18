// ============================================================================
// `PublicationService.authorListing` — whether an author Safe's append becomes
// an agreement.
//
// The module's `makeOffer` has exactly two ways into the agreement set: the
// publication Safe (`msg.sender == safe`) and a whitelisted author
// (`authorSet[msg.sender]`). Everyone else's append is an offer, and an edit to
// an already-agreed document from an unlisted author *suspends* the agreement
// and moves it back to the offer set. So the answer never consults
// `getAgreements`: an existing agreement would not keep the next version on the
// site, and saying "listed" there would reproduce the bug this gate exists to
// stop.
//
// The shared resolvers are stubbed so the service builds without a chain, and
// the EOA runner records every read it is asked to make.
// ============================================================================

import type { Address } from 'viem';
import type { TxRunner } from '@s2s/soul2soul-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePublicationSafe, resolvePublicationModules } = vi.hoisted(() => ({
  resolvePublicationSafe: vi.fn(),
  resolvePublicationModules: vi.fn(),
}));

vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared')>();
  return { ...actual, resolvePublicationSafe, resolvePublicationModules };
});

import { PublicationService } from '../src/core/service';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const AUTHOR = '0x1111111111111111111111111111111111111111' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const CONFIG = '0x0000000000000000000000000000000000000022' as Address;
const ENS = '0x0000000000000000000000000000000000000033' as Address;
const PUBLICATION = 'test.soul2soul.eth';

/** The EOA runner, with every read recorded by function name and arguments. */
function fakeRunner(answers: Record<string, unknown>) {
  const genericRead = vi.fn(
    (_address: string, _abi: string, fn: string, _args: unknown[]): Promise<unknown> => {
      const answer = answers[fn];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  );
  return { genericRead };
}

async function build(answers: Record<string, unknown>) {
  resolvePublicationSafe.mockResolvedValue({ address: SAFE, name: 'test' });
  resolvePublicationModules.mockResolvedValue({ configModule: CONFIG, publicationModule: MODULE });

  const l2Runner = fakeRunner(answers);
  const service = await PublicationService.init(
    {
      l1: {} as never,
      l2: {} as never,
      l2Runner: l2Runner as unknown as TxRunner,
      ensRegistry: ENS,
      ipfs: {} as never,
    },
    PUBLICATION,
  );
  return { service, l2Runner };
}

describe('authorListing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admits the publication Safe without reading the whitelist', async () => {
    const { service, l2Runner } = await build({ isWhitelistedAuthor: false });

    // Case-insensitive: the Safe answers checksummed, callers may hold lowercase.
    await expect(service.authorListing(SAFE.toLowerCase() as Address)).resolves.toEqual({
      listed: true,
      via: 'publication-safe',
    });
    expect(l2Runner.genericRead).not.toHaveBeenCalled();
  });

  it('names a whitelisted author', async () => {
    const { service, l2Runner } = await build({ isWhitelistedAuthor: true });

    await expect(service.authorListing(AUTHOR)).resolves.toEqual({
      listed: true,
      via: 'whitelist',
    });
    expect(l2Runner.genericRead).toHaveBeenCalledWith(
      MODULE,
      expect.stringContaining('isWhitelistedAuthor'),
      'isWhitelistedAuthor',
      [AUTHOR],
    );
  });

  it('does not page agreements to rescue an unlisted author', async () => {
    // The document may well be under an agreement right now. The next append
    // from this author suspends it, so the standing is not a pass.
    const { service, l2Runner } = await build({ isWhitelistedAuthor: false, getAgreements: [] });

    await expect(service.authorListing(AUTHOR)).resolves.toEqual({ listed: false });
    expect(l2Runner.genericRead).toHaveBeenCalledTimes(1);
    expect(l2Runner.genericRead.mock.calls[0]?.[2]).toBe('isWhitelistedAuthor');
  });

  it('refuses an author who is none of the three', async () => {
    const { service } = await build({ isWhitelistedAuthor: false });
    await expect(service.authorListing(AUTHOR)).resolves.toEqual({ listed: false });
  });

  it('propagates a failed read instead of guessing', async () => {
    const { service } = await build({ isWhitelistedAuthor: new Error('rpc down') });
    await expect(service.authorListing(AUTHOR)).rejects.toThrow('rpc down');
  });
});
