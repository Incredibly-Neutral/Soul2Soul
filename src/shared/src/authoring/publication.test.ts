import { describe, it, expect } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { resolvePublicationModules } from './publication';

// Discovery is decision logic over a module list, so it is tested without a
// chain: the Safe's enabled list, what each module answers for `NAME()`, and
// what the factory predicts. Every read is recorded — the fallback is only
// correct if it is the *only* thing read when the factory cannot answer.

const SAFE = '0x' + 'aa'.repeat(20);
const FACTORY = '0x' + 'ff'.repeat(20);
const SENTINEL = '0x0000000000000000000000000000000000000001';
const AT = (n: number) => ('0x' + String(n).repeat(40)) as Address;

const RECORDS = AT(1);
const PUBLICATION_V2 = AT(2);
const PUBLICATION_V3 = AT(3);
const OTHER = AT(9);

interface ChainOptions {
  modules: Address[];
  /** module → NAME(); a module absent here has no NAME() and reverts */
  names: Record<string, string>;
  /** `implementationCount()`; `'revert'` is a V2-generation factory */
  count?: bigint | 'revert';
  /** `moduleAddress(safe)` */
  latest?: Address;
  /** version (as a string) → predicted address */
  predictions?: Record<string, Address>;
  /** addresses that hold bytecode */
  code?: Address[];
}

function makeChain(options: ChainOptions) {
  const calls: string[] = [];

  const client = {
    readContract: async ({ address, functionName, args }: any) => {
      calls.push(args?.[1] === undefined ? `${functionName}:${address}` : `${functionName}:${args[1]}`);
      if (functionName === 'getModulesPaginated') return [options.modules, SENTINEL];
      if (functionName === 'NAME') {
        const name = options.names[address];
        if (name === undefined) throw new Error('execution reverted');
        return name;
      }
      if (functionName === 'implementationCount') {
        if (options.count === 'revert') throw new Error('execution reverted');
        return options.count ?? 0n;
      }
      if (functionName === 'moduleAddress') {
        if (options.latest === undefined) throw new Error('execution reverted');
        return options.latest;
      }
      if (functionName === 'moduleAddressForVersion') {
        const answer = options.predictions?.[String(args[1])];
        if (answer === undefined) throw new Error('execution reverted');
        return answer;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getCode: async ({ address }: any) =>
      options.code?.some((a) => a.toLowerCase() === address.toLowerCase()) ? '0x6000' : '0x',
  } as unknown as PublicClient;

  return { client, calls };
}

const bothNames = {
  [RECORDS]: 'S2S Records Module',
  [PUBLICATION_V2]: 'S2S Publication Module V2',
  [PUBLICATION_V3]: 'S2S Publication Module V3',
  [OTHER]: 'Not A Module',
};

describe('resolvePublicationModules', () => {
  it('without a factory, resolves both modules by NAME() as before', async () => {
    const { client, calls } = makeChain({
      modules: [RECORDS, PUBLICATION_V2, OTHER],
      names: bothNames,
    });
    const resolved = await resolvePublicationModules(client, SAFE as Address);
    expect(resolved).toEqual({ configModule: RECORDS, publicationModule: PUBLICATION_V2 });
    expect(calls.some((call) => call.startsWith('implementationCount'))).toBe(false);
  });

  it('accepts a V1 publication module, so an old publication keeps its module', async () => {
    const { client } = makeChain({
      modules: [RECORDS, PUBLICATION_V2],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION_V2]: 'S2S Publication Module' },
    });
    expect((await resolvePublicationModules(client, SAFE as Address)).publicationModule).toBe(
      PUBLICATION_V2,
    );
  });

  it('a CREATE2 factory answers the publication module before any NAME() sniff', async () => {
    const { client, calls } = makeChain({
      modules: [RECORDS, PUBLICATION_V3],
      names: bothNames,
      count: 1n,
      latest: PUBLICATION_V3,
    });
    const resolved = await resolvePublicationModules(client, SAFE as Address, FACTORY as Address);
    expect(resolved).toEqual({ configModule: RECORDS, publicationModule: PUBLICATION_V3 });
    // The prediction is read before any NAME() probe; the records module still
    // needs its NAME().
    const firstFactoryRead = calls.findIndex((call) => call.startsWith('moduleAddress'));
    const firstNameRead = calls.findIndex((call) => call.startsWith('NAME:'));
    expect(firstFactoryRead).toBeGreaterThanOrEqual(0);
    expect(firstFactoryRead).toBeLessThan(firstNameRead);
    expect(calls).toContain(`NAME:${RECORDS}`);
  });

  it('the prediction is not overturned by a second module carrying a publication name', async () => {
    const { client } = makeChain({
      modules: [RECORDS, PUBLICATION_V2, PUBLICATION_V3],
      names: bothNames,
      count: 1n,
      latest: PUBLICATION_V3,
    });
    expect(
      (await resolvePublicationModules(client, SAFE as Address, FACTORY as Address)).publicationModule,
    ).toBe(PUBLICATION_V3);
  });

  it('falls back to the NAME() scan when the factory has no CREATE2 selector', async () => {
    const { client, calls } = makeChain({
      modules: [RECORDS, PUBLICATION_V2],
      names: bothNames,
      count: 'revert',
    });
    const resolved = await resolvePublicationModules(client, SAFE as Address, FACTORY as Address);
    expect(resolved).toEqual({ configModule: RECORDS, publicationModule: PUBLICATION_V2 });
    expect(calls).toContain(`implementationCount:${FACTORY}`);
    expect(calls).toContain(`NAME:${PUBLICATION_V2}`);
  });

  it('falls back to the NAME() scan when the factory predicts an address not enabled on the Safe', async () => {
    const { client } = makeChain({
      modules: [RECORDS, PUBLICATION_V2],
      names: bothNames,
      count: 1n,
      latest: PUBLICATION_V3,
    });
    expect(
      (await resolvePublicationModules(client, SAFE as Address, FACTORY as Address)).publicationModule,
    ).toBe(PUBLICATION_V2);
  });

  it('treats a zero-address answer as no prediction, so the scan still answers', async () => {
    const { client } = makeChain({
      modules: [RECORDS, PUBLICATION_V2],
      names: bothNames,
      count: 1n,
      latest: '0x0000000000000000000000000000000000000000' as Address,
    });
    const resolved = await resolvePublicationModules(client, SAFE as Address, FACTORY as Address);
    expect(resolved).toEqual({ configModule: RECORDS, publicationModule: PUBLICATION_V2 });
  });

  it('falls back to the NAME() scan when the factory count is above the walk cap', async () => {
    const { client } = makeChain({
      modules: [RECORDS, PUBLICATION_V2],
      names: bothNames,
      count: 9n,
      latest: PUBLICATION_V3,
    });
    expect(
      (await resolvePublicationModules(client, SAFE as Address, FACTORY as Address)).publicationModule,
    ).toBe(PUBLICATION_V2);
  });

  it('finds no publication module when nothing answers, rather than guessing', async () => {
    const { client } = makeChain({
      modules: [RECORDS, OTHER],
      names: bothNames,
      count: 'revert',
    });
    expect(await resolvePublicationModules(client, SAFE as Address, FACTORY as Address)).toEqual({
      configModule: RECORDS,
      publicationModule: undefined,
    });
  });
});
