import { describe, it, expect } from 'vitest';
import { utils } from 'ethers';
import {
  DRAFTS_MODULE_INTERFACE_ID,
  OWNER_HISTORY_MODULE_INTERFACE_ID,
  resolveAuthorModules,
} from './modules';
import type { GateRead, GateValueRead } from './index';

// The resolver is decision logic over two injected reads, so it is tested
// without a chain: a table of enabled modules, and a table of who answers which
// role id. Every read is recorded, because the number of eth_calls is part of
// the contract with a Lit session.

const SAFE = '0x' + 'aa'.repeat(20);
const FACTORY = '0x' + 'ff'.repeat(20);
const MODULE = (n: number) => '0x' + String(n).repeat(40).slice(0, 40);
const DRAFTS = MODULE(1);
const HISTORY = MODULE(2);
const PUBLICATION = MODULE(3);
const GUARD = MODULE(4);
const OTHER = MODULE(5);

interface ChainOptions {
  enabled?: string[];
  /** module → the interface ids it answers true for */
  answers?: Record<string, string[]>;
  /** modules whose supportsInterface reverts */
  reverts?: string[];
  /** factory predictions; `null` means the factory reverts */
  predicted?: { drafts?: string; ownerHistory?: string } | null;
  pageSizeAnswers?: [string[], string][];
}

const chain = (options: ChainOptions) => {
  const calls: string[] = [];
  let pageIndex = 0;

  const read: GateRead = async (target, _abi, fn, args) => {
    calls.push(`${fn}:${target}:${String(args[0])}`);
    if (options.reverts?.includes(target)) throw new Error('execution reverted');
    const answered = options.answers?.[target] ?? [];
    return answered.includes(String(args[0]));
  };

  const readValue: GateValueRead = async (target, _abi, fn, args) => {
    calls.push(`${fn}:${target}:${String(args[0])}`);
    if (fn === 'getModulesPaginated') {
      if (options.pageSizeAnswers) {
        const page = options.pageSizeAnswers[Math.min(pageIndex, options.pageSizeAnswers.length - 1)];
        pageIndex += 1;
        return page;
      }
      return [options.enabled ?? [], '0x' + '0'.repeat(40)];
    }
    if (fn === 'draftsModuleAddress' || fn === 'ownerHistoryModuleAddress') {
      if (options.predicted === null) throw new Error('factory reverted');
      return fn === 'draftsModuleAddress' ? options.predicted?.drafts : options.predicted?.ownerHistory;
    }
    throw new Error(`unexpected read ${fn}:${target}`);
  };

  return { read, readValue, calls };
};

const bothRoles = {
  [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID],
  [HISTORY]: [OWNER_HISTORY_MODULE_INTERFACE_ID],
};

describe('role ids', () => {
  // The ids are compile-time constants of the deployed bytecode and may never
  // change once a module is published. These are the function sets of
  // `IDraftsModule` and `IOwnerHistoryModule` in src/author/contracts/src — the
  // same selectors the generated ABIs give — so a typo in a constant, or a
  // function added to the interface without reissuing the id, fails here.
  const DRAFTS_INTERFACE = [
    'append(bytes32,string)',
    'isDraft(bytes32)',
    'authorOf(bytes32)',
    'count()',
  ];
  const OWNER_HISTORY_INTERFACE = [
    'sync()',
    'isOwner(address)',
    'isOwnerAt(address,uint256)',
    'wasOwnerAt(address,uint256)',
    'eraCount()',
  ];

  const interfaceId = (signatures: string[]): string =>
    '0x' +
    (
      signatures
        .map((signature) => parseInt(utils.id(signature).slice(2, 10), 16))
        .reduce((a, b) => a ^ b, 0) >>> 0
    )
      .toString(16)
      .padStart(8, '0');

  it('matches the ERC-165 id of IDraftsModule', () => {
    expect(interfaceId(DRAFTS_INTERFACE)).toBe(DRAFTS_MODULE_INTERFACE_ID);
  });

  it('matches the ERC-165 id of IOwnerHistoryModule, and it is not the drafts id', () => {
    expect(interfaceId(OWNER_HISTORY_INTERFACE)).toBe(OWNER_HISTORY_MODULE_INTERFACE_ID);
    expect(OWNER_HISTORY_MODULE_INTERFACE_ID).not.toBe(DRAFTS_MODULE_INTERFACE_ID);
  });

  it('neither role id is the ERC-165 query id', () => {
    expect(DRAFTS_MODULE_INTERFACE_ID).not.toBe('0x01ffc9a7');
    expect(OWNER_HISTORY_MODULE_INTERFACE_ID).not.toBe('0x01ffc9a7');
  });
});

describe('resolveAuthorModules', () => {
  it('picks the drafts module and the owner-history module out of a Safe carrying several', async () => {
    const { read, readValue } = chain({
      enabled: [PUBLICATION, DRAFTS, GUARD, HISTORY, OTHER],
      answers: bothRoles,
    });

    const result = await resolveAuthorModules(read, readValue, SAFE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
  });

  it('costs one page plus two probes per enabled module, and says so', async () => {
    const { read, readValue, calls } = chain({
      enabled: [PUBLICATION, DRAFTS, GUARD, HISTORY, OTHER],
      answers: bothRoles,
    });

    const result = await resolveAuthorModules(read, readValue, SAFE);

    expect(calls).toHaveLength(1 + 2 * 5);
    expect(result.reads).toBe(calls.length);
  });

  it('refuses two enabled modules answering the drafts role instead of picking one', async () => {
    const { read, readValue } = chain({
      enabled: [DRAFTS, OTHER, HISTORY],
      answers: {
        ...bothRoles,
        [OTHER]: [DRAFTS_MODULE_INTERFACE_ID],
      },
    });

    const result = await resolveAuthorModules(read, readValue, SAFE);

    expect(result).toEqual({ ok: false, error: 'ambiguous-drafts-module', reads: 1 + 2 * 3 });
  });

  it('refuses two enabled modules answering the owner-history role', async () => {
    const { read, readValue } = chain({
      enabled: [DRAFTS, HISTORY, OTHER],
      answers: { ...bothRoles, [OTHER]: [OWNER_HISTORY_MODULE_INTERFACE_ID] },
    });

    expect(await resolveAuthorModules(read, readValue, SAFE)).toEqual({
      ok: false,
      error: 'ambiguous-owner-history-module',
      reads: 1 + 2 * 3,
    });
  });

  it('survives a module whose supportsInterface reverts and still resolves the others', async () => {
    const { read, readValue } = chain({
      enabled: [PUBLICATION, DRAFTS, HISTORY],
      answers: bothRoles,
      reverts: [PUBLICATION],
    });

    const result = await resolveAuthorModules(read, readValue, SAFE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
  });

  it('answers "no drafts module" when the only claimant reverts', async () => {
    const { read, readValue } = chain({
      enabled: [DRAFTS, HISTORY],
      answers: bothRoles,
      reverts: [DRAFTS],
    });

    expect(await resolveAuthorModules(read, readValue, SAFE)).toEqual({
      ok: false,
      error: 'no-drafts-module',
      reads: 1 + 2 * 2,
    });
  });

  it('ignores a module answering the ERC-165 query alone', async () => {
    const { read, readValue } = chain({
      enabled: [GUARD, HISTORY],
      answers: { ...bothRoles, [GUARD]: ['0x01ffc9a7'] },
    });

    expect(await resolveAuthorModules(read, readValue, SAFE)).toMatchObject({
      ok: false,
      error: 'no-drafts-module',
    });
  });

  it('refuses a Safe with no enabled modules without probing anything', async () => {
    const { read, readValue } = chain({ enabled: [], answers: {} });

    expect(await resolveAuthorModules(read, readValue, SAFE)).toEqual({
      ok: false,
      error: 'no-enabled-modules',
      reads: 1,
    });
  });

  it('treats the factory prediction as a hint: an enabled predicted module is used', async () => {
    const { read, readValue } = chain({
      enabled: [PUBLICATION, HISTORY, DRAFTS],
      answers: bothRoles,
      predicted: { drafts: DRAFTS, ownerHistory: HISTORY },
    });

    const result = await resolveAuthorModules(read, readValue, SAFE, { factory: FACTORY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
    // Two predictions plus the page, then two probes per enabled module.
    expect(result.reads).toBe(2 + 1 + 2 * 3);
  });

  it('never takes a prediction that the Safe has not enabled, even when it answers the role', async () => {
    const NOT_ENABLED = MODULE(9);
    const { read, readValue } = chain({
      enabled: [PUBLICATION, HISTORY],
      answers: { ...bothRoles, [NOT_ENABLED]: [DRAFTS_MODULE_INTERFACE_ID] },
      predicted: { drafts: NOT_ENABLED, ownerHistory: HISTORY },
    });

    // Only HISTORY is enabled, and nothing enabled answers the drafts role: the
    // prediction is not in the Safe's list, so the lookup refuses.
    expect(await resolveAuthorModules(read, readValue, SAFE, { factory: FACTORY })).toMatchObject({
      ok: false,
      error: 'no-drafts-module',
    });
  });

  it('still resolves when the factory does not answer', async () => {
    const { read, readValue } = chain({
      enabled: [DRAFTS, HISTORY],
      answers: bothRoles,
      predicted: null,
    });

    const result = await resolveAuthorModules(read, readValue, SAFE, { factory: FACTORY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
  });

  it('walks a Safe whose module list comes back in pages', async () => {
    const { read, readValue } = chain({
      enabled: [PUBLICATION, DRAFTS],
      answers: bothRoles,
      pageSizeAnswers: [
        [[PUBLICATION], DRAFTS],
        [[DRAFTS, HISTORY], '0x' + '0'.repeat(40)],
      ],
    });

    const result = await resolveAuthorModules(read, readValue, SAFE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
  });

  it('refuses a Safe with a drafts log and no owner-history module by default', async () => {
    // The owner history is required unless the caller says otherwise: a caller
    // that has to judge a block cannot decide without it.
    const { read, readValue } = chain({
      enabled: [DRAFTS],
      answers: { [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID] },
    });

    expect(await resolveAuthorModules(read, readValue, SAFE)).toMatchObject({
      ok: false,
      error: 'no-owner-history-module',
    });
  });

  it('resolves the drafts log alone when the owner history is optional', async () => {
    const { read, readValue } = chain({
      enabled: [DRAFTS],
      answers: { [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID] },
    });

    const result = await resolveAuthorModules(read, readValue, SAFE, {
      ownerHistoryOptional: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBeUndefined();
  });

  it('still refuses two owner-history claimants when the module is optional', async () => {
    // Absent is a case a caller may handle; ambiguous is not: two histories on
    // one Safe leave no single answer at any block.
    const other = MODULE(6);
    const { read, readValue } = chain({
      enabled: [DRAFTS, HISTORY, other],
      answers: { ...bothRoles, [other]: [OWNER_HISTORY_MODULE_INTERFACE_ID] },
    });

    expect(
      await resolveAuthorModules(read, readValue, SAFE, { ownerHistoryOptional: true }),
    ).toMatchObject({ ok: false, error: 'ambiguous-owner-history-module' });
  });

  it('refuses a Safe whose module list cannot be read', async () => {
    const read: GateRead = async () => true;
    const readValue: GateValueRead = async () => {
      throw new Error('execution reverted');
    };

    expect(await resolveAuthorModules(read, readValue, SAFE)).toEqual({
      ok: false,
      error: 'unreadable-module-list',
      reads: 1,
    });
  });
});
