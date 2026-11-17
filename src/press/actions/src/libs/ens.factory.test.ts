import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDomainOwnerAndModules } from './ens.factory';

// ============================================================================
// Module discovery through the V6 factory.
//
// What these tests hold down:
//
//   1. The two kinds are read from the factory the `publication_factory` record
//      names, and from nowhere else: `moduleAddress(safe, kind)` answers, and
//      the answer counts only when code is deployed at it. There is no
//      enabled-module list read, no supportsInterface probe, no NAME() match,
//      no version walk in this path.
//   2. A prediction with no code at it, a zero answer, and an answer for a kind
//      the factory does not know are all "no module", never a discovered one.
//   3. A factory that does not answer throws. A revert (a factory older than
//      V6, with no `moduleAddress`) and a transport failure are indistinguishable
//      to the caller, and this code does not try to tell them apart: both fail
//      the action loudly, and neither is reported as a null module.
//   4. The ENS walk is unchanged (nameWrapper -> ownerOf at namehash(publication)),
//      and it is counted, because every request spends one of Lit's 50 per
//      session.
//
// The factory argument is required in the type, so a call site that has no
// `publication_factory` record cannot reach discovery at all — that refusal is
// enforced at the call sites, which throw on a null record.
//
// The protocol's own records module is not resolved here: it is
// `PROTOCOL_RECORDS_MODULE`, held as a constant because it is where the factory
// address comes from. See protocol.factory.ts.
// ============================================================================

const state = vi.hoisted(() => {
  const PUBLICATION_KIND = '0x' + '93'.repeat(32);
  const RECORDS_KIND = '0x' + '32'.repeat(32);
  const NAME_WRAPPER = '0x' + 'aa'.repeat(20);
  const OWNER = '0x' + 'bb'.repeat(20);
  const NODE = '0x' + 'ab'.repeat(32);

  const s = {
    // What each ENS read answers.
    nameWrapper: NAME_WRAPPER,
    owner: OWNER,
    // The factory's answer per kind: an address, or undefined for none.
    answers: {} as Record<string, string>,
    // 'revert' or 'transport' makes every moduleAddress read throw in that shape.
    factoryFailure: null as null | 'revert' | 'transport',
    // Deployed code per address (lowercased). Absent means '0x' — no code.
    code: {} as Record<string, string>,
    // Every evmRead, every evmGetCode, and every namehash, in order.
    reads: [] as { chain: string; address: string; method: string; args: unknown[] }[],
    codeReads: [] as { chain: string; address: string }[],
    namehashCalls: [] as string[],
  };

  // The bundle injects `ethers` at runtime; ens.factory computes the two kinds
  // and the ENS node from it at module load, so the stub must exist before the
  // import is evaluated — hence vi.hoisted.
  (globalThis as any).ethers = {
    utils: {
      id: (text: string) => {
        if (text === 's2s.module.publication') return PUBLICATION_KIND;
        if (text === 's2s.module.records') return RECORDS_KIND;
        throw new Error('unexpected kind text ' + text);
      },
      namehash: (name: string) => {
        s.namehashCalls.push(name);
        return NODE;
      },
    },
  };

  return Object.assign(s, {
    PUBLICATION_KIND,
    RECORDS_KIND,
    NAME_WRAPPER,
    OWNER,
    NODE,
  });
});

vi.mock('./evm', () => ({
  evmRead: vi.fn(
    async (chain: string, contractAddress: string, _abi: any, method: string, args: any[]) => {
      // The shape evm.ts throws when every URL failed: one Error carrying
      // `.failures`, each entry the per-URL message.
      const rpcFailure = (...messages: string[]) => {
        const failures = messages.map((m) => `RPC call to https://rpc.l2 failed: ${m}`);
        const err = new Error(failures.join(' | '));
        (err as any).failures = failures;
        return err;
      };

      state.reads.push({ chain, address: contractAddress, method, args });
      switch (method) {
        case 'nameWrapper':
          return state.nameWrapper;
        case 'ownerOf':
          return state.owner;
        case 'moduleAddress': {
          if (state.factoryFailure === 'revert') {
            throw rpcFailure('execution reverted: no moduleAddress');
          }
          if (state.factoryFailure === 'transport') {
            throw rpcFailure('missing response');
          }
          // The contract answers the zero address, not a revert, when no
          // implementation is set for the kind.
          const answer = state.answers[args[1] as string];
          return answer ?? '0x' + '00'.repeat(20);
        }
        default:
          throw new Error('unexpected method ' + method);
      }
    },
  ),
  evmGetCode: vi.fn(async (chain: string, address: string) => {
    state.codeReads.push({ chain, address });
    return state.code[address.toLowerCase()] ?? '0x';
  }),
}));

const PUBLICATION = '0x' + '22'.repeat(20);
const RECORDS = '0x' + '11'.repeat(20);
const ZERO_ADDRESS = '0x' + '00'.repeat(20);
const FACTORY = '0x' + '55'.repeat(20);

const { PUBLICATION_KIND, RECORDS_KIND, NAME_WRAPPER, OWNER, NODE } = state;

const hasCode = (address: string) => {
  state.code[address.toLowerCase()] = '0x60806040';
};

const nameKind = (kind: string, address: string) => {
  state.answers[kind] = address;
};

const factoryReads = () => state.reads.filter((read) => read.method === 'moduleAddress');
const codeAddresses = () => state.codeReads.map((read) => read.address);

beforeEach(() => {
  state.nameWrapper = NAME_WRAPPER;
  state.owner = OWNER;
  state.answers = {};
  state.factoryFailure = null;
  state.code = {};
  state.reads = [];
  state.codeReads = [];
  state.namehashCalls = [];
});

describe('getDomainOwnerAndModules — both kinds from the factory', () => {
  it('resolves both modules, with one moduleAddress per kind and one getCode per answer', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, PUBLICATION);
    hasCode(RECORDS);
    hasCode(PUBLICATION);

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.multisig).toBe(OWNER);
    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    // Exactly two factory reads, one per kind, on the publication Safe.
    expect(factoryReads().map((read) => read.address)).toEqual([FACTORY, FACTORY]);
    expect(factoryReads().map((read) => read.args)).toEqual([
      [OWNER, RECORDS_KIND],
      [OWNER, PUBLICATION_KIND],
    ]);
    // Exactly one code read per non-zero answer.
    expect(codeAddresses()).toEqual([RECORDS, PUBLICATION]);
    // The whole discovery: 2 ENS reads + 2 factory reads + 2 code reads.
    expect(state.reads.length + state.codeReads.length).toBe(6);
  });

  it('walks ENS: nameWrapper, then ownerOf at namehash(publication)', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    hasCode(RECORDS);

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(state.namehashCalls).toEqual(['example.eth']);
    const ownerOf = state.reads.find((read) => read.method === 'ownerOf');
    expect(ownerOf?.address).toBe(NAME_WRAPPER);
    expect(ownerOf?.args).toEqual([NODE]);
    expect(result.multisig).toBe(OWNER);
    // The factory is asked for the Safe the ENS walk found, not the name.
    expect(factoryReads()[0].args[0]).toBe(OWNER);
  });

  it('reads the ENS walk on L1, and the factory and the code on L2', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, PUBLICATION);
    hasCode(RECORDS);
    hasCode(PUBLICATION);

    await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    const chainsOf = (methods: string[]) =>
      state.reads.filter((read) => methods.includes(read.method)).map((read) => read.chain);
    // ENS lives on L1; the factory and the module it names live on Base.
    expect(chainsOf(['nameWrapper', 'ownerOf'])).toEqual(['L1', 'L1']);
    expect(chainsOf(['moduleAddress'])).toEqual(['L2', 'L2']);
    expect(state.codeReads.map((read) => read.chain)).toEqual(['L2', 'L2']);
  });

  it('refuses a kind whose answer is a prediction with no code at it', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, PUBLICATION);
    hasCode(RECORDS);

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBeNull();
    // The prediction was checked, not trusted.
    expect(codeAddresses()).toEqual([RECORDS, PUBLICATION]);
  });

  it('refuses a kind the factory answers with the zero address, without reading code at it', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, ZERO_ADDRESS);
    hasCode(RECORDS);

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBeNull();
    expect(codeAddresses()).toEqual([RECORDS]);
  });

  it('resolves one kind when only the other has code at it', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, PUBLICATION);
    hasCode(PUBLICATION);

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.configModule).toBeNull();
    expect(result.publicationModule).toBe(PUBLICATION);
  });

  it('returns null for both kinds when the factory names neither', async () => {
    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.multisig).toBe(OWNER);
    expect(result.configModule).toBeNull();
    expect(result.publicationModule).toBeNull();
    expect(codeAddresses()).toEqual([]);
    // 2 ENS reads + 2 factory reads, and nothing else.
    expect(state.reads.length).toBe(4);
  });

  it('fails loudly when the factory does not answer — a factory older than V6 reverts', async () => {
    nameKind(RECORDS_KIND, RECORDS);
    nameKind(PUBLICATION_KIND, PUBLICATION);
    state.factoryFailure = 'revert';

    const err: any = await getDomainOwnerAndModules('example.eth', undefined, FACTORY).catch(
      (e) => e,
    );

    // Not a null module: the action fails, and the caller refuses on the error.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('execution reverted');
    // No address was resolved, so no code was read at any of them.
    expect(codeAddresses()).toEqual([]);
  });

  it('fails the same way on a transport failure — the two are not separated', async () => {
    state.factoryFailure = 'transport';

    const err: any = await getDomainOwnerAndModules('example.eth', undefined, FACTORY).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('missing response');
    expect(codeAddresses()).toEqual([]);
  });
});
