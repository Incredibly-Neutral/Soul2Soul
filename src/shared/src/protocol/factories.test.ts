import { describe, it, expect } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { MAX_PUBLICATION_FACTORY_VERSIONS, predictPublicationModule } from './factories';

// The prediction is decision logic over a handful of reads, so it is tested
// without a chain: a table of what the factory answers, and a table of which
// addresses have code. The number and order of reads is part of the contract (a
// Lit session has a request cap, and a hostile count must not run away), so
// every call is recorded.

const SAFE = '0x' + 'aa'.repeat(20);
const FACTORY = '0x' + 'ff'.repeat(20);
const ZERO = '0x' + '0'.repeat(40);
const AT = (n: number) => ('0x' + String(n).repeat(40)) as Address;

const LATEST = AT(1);
const OLDER = AT(2);

interface ChainOptions {
  /** `implementationCount()`; `'revert'` is a V2-generation factory */
  count?: bigint | 'revert';
  /** `moduleAddress(safe)` */
  latest?: Address | 'revert';
  /** version (as a string) → moduleAddressForVersion */
  predictions?: Record<string, Address | 'revert'>;
  /** addresses that hold bytecode */
  code?: Address[];
}

function makeChain(options: ChainOptions = {}) {
  const calls: string[] = [];

  const client = {
    readContract: async ({ functionName, args }: any) => {
      if (functionName === 'implementationCount') {
        calls.push('implementationCount');
        if (options.count === 'revert') throw new Error('execution reverted');
        return options.count ?? 0n;
      }
      if (functionName === 'moduleAddress') {
        calls.push('moduleAddress');
        if (options.latest === 'revert') throw new Error('execution reverted');
        return options.latest;
      }
      if (functionName === 'moduleAddressForVersion') {
        calls.push(`moduleAddressForVersion:${args[1]}`);
        const answer = options.predictions?.[String(args[1])];
        if (answer === 'revert') throw new Error('execution reverted');
        return answer;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getCode: async ({ address }: any) => {
      calls.push(`getCode:${address}`);
      return options.code?.some((a) => a.toLowerCase() === address.toLowerCase()) ? '0x6000' : '0x';
    },
  } as unknown as PublicClient;

  return { client, calls };
}

describe('predictPublicationModule', () => {
  it('answers undefined when the factory has no moduleAddress — a V2 factory', async () => {
    const { client, calls } = makeChain({ count: 'revert', latest: 'revert' });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address)).toBeUndefined();
    // Two selector probes and nothing more: no version is guessed.
    expect(calls).toEqual(['moduleAddress', 'implementationCount']);
  });

  it('answers undefined when the factory names no implementation yet', async () => {
    const { client, calls } = makeChain({ count: 0n, latest: 'revert' });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address)).toBeUndefined();
    expect(calls).toEqual(['moduleAddress', 'implementationCount']);
  });

  it('answers for the latest implementation even when the count is above the cap', async () => {
    const { client, calls } = makeChain({
      count: BigInt(MAX_PUBLICATION_FACTORY_VERSIONS + 1),
      latest: LATEST,
    });
    const answer = await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [LATEST]);
    expect(answer).toBe(LATEST);
    // moduleAddress is asked before the count is known, so a factory that has
    // rotated more times than the cap still answers in one call.
    expect(calls).toEqual(['moduleAddress']);
  });

  it('walks only down to the cap when the count is above it', async () => {
    const { client, calls } = makeChain({
      count: BigInt(MAX_PUBLICATION_FACTORY_VERSIONS + 1),
      latest: LATEST,
      predictions: { '1': OLDER },
    });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [OLDER]),
    ).toBe(OLDER);
    // Latest is not this Safe's; versions 7 down to 1 are asked, newest first.
    expect(calls).toEqual([
      'moduleAddress',
      'implementationCount',
      'moduleAddressForVersion:7',
      'moduleAddressForVersion:6',
      'moduleAddressForVersion:5',
      'moduleAddressForVersion:4',
      'moduleAddressForVersion:3',
      'moduleAddressForVersion:2',
      'moduleAddressForVersion:1',
    ]);
    expect(calls).not.toContain('moduleAddressForVersion:8');
  });

  it('accepts a latest-version prediction that is in the Safe’s enabled-module list', async () => {
    const { client, calls } = makeChain({ count: 1n, latest: LATEST });
    const answer = await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [LATEST]);
    expect(answer).toBe(LATEST);
    // Membership is the proof when the list is non-empty, so no count and no
    // code read is needed.
    expect(calls).toEqual(['moduleAddress']);
  });

  it('tries moduleAddress before walking older versions', async () => {
    const { client, calls } = makeChain({ count: 3n, latest: LATEST });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [LATEST, OLDER]),
    ).toBe(LATEST);
    expect(calls).toEqual(['moduleAddress']);
  });

  it('walks older versions when the latest prediction is not enabled on this Safe', async () => {
    const { client, calls } = makeChain({
      count: 2n,
      latest: LATEST,
      predictions: { '1': OLDER },
    });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [OLDER]),
    ).toBe(OLDER);
    expect(calls).toEqual(['moduleAddress', 'implementationCount', 'moduleAddressForVersion:1']);
  });

  it('refuses a prediction that has code but is not in a non-empty enabled list', async () => {
    const { client, calls } = makeChain({
      count: 1n,
      latest: LATEST,
      code: [LATEST],
    });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [OLDER])).toBeUndefined();
    // Code was never consulted: a non-empty list is the only proof allowed.
    expect(calls).toEqual(['moduleAddress', 'implementationCount']);
  });

  it('uses code as the proof when the Safe listed no modules at all', async () => {
    const { client, calls } = makeChain({ count: 1n, latest: LATEST, code: [LATEST] });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address)).toBe(LATEST);
    expect(calls).toEqual(['moduleAddress', `getCode:${LATEST}`]);
  });

  it('refuses a prediction nobody deployed when the enabled list is empty', async () => {
    const { client } = makeChain({ count: 1n, latest: LATEST });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address)).toBeUndefined();
  });

  it('treats a zero-address answer as no answer', async () => {
    const { client, calls } = makeChain({ count: 1n, latest: ZERO as Address, code: [LATEST] });
    expect(await predictPublicationModule(client, FACTORY as Address, SAFE as Address)).toBeUndefined();
    // Not even a code read: the zero address is not a candidate.
    expect(calls).toEqual(['moduleAddress', 'implementationCount']);
  });

  it('treats a zero-address answer as no answer when the list is non-empty', async () => {
    const { client } = makeChain({ count: 1n, latest: ZERO as Address });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [ZERO as Address]),
    ).toBeUndefined();
  });

  it('skips a version the factory does not know', async () => {
    const { client } = makeChain({
      count: 3n,
      latest: LATEST,
      predictions: { '2': 'revert', '1': OLDER },
    });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [OLDER]),
    ).toBe(OLDER);
  });

  it('answers undefined when moduleAddress reverts, as on a factory set up before the selector', async () => {
    const { client } = makeChain({ count: 1n, latest: 'revert' });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [LATEST]),
    ).toBeUndefined();
  });

  it('address comparison is case-insensitive on both sides', async () => {
    const checksummed = '0xAbC0000000000000000000000000000000000001' as Address;
    const { client } = makeChain({ count: 1n, latest: checksummed.toLowerCase() as Address });
    expect(
      await predictPublicationModule(client, FACTORY as Address, SAFE as Address, [checksummed]),
    ).toBe(checksummed.toLowerCase());
  });
});
