// ============================================================================
// The drafts log's write — `appendDraft`, the call every real upload makes, and
// `s2s drafts append`, the retry that failure names.
//
// The reads are faked as one object (`DraftsSeam`), the Safe state and the
// runner are faked, and the send is a `vi.fn()`: what is under test is the call
// the module receives (its address, the bytes32 genesis, the cid, the deploy
// flag, the msg.sender the simulation uses), where the version count comes
// from, and the error text a failure produces. Not viem's encoding.
// ============================================================================

import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { DraftsModuleV1 } from '@s2s/author-contracts';
import { toBytes32Id } from '@s2s/soul2soul-shared';

import { appendDraft, type DraftsSeam } from '../src/core/drafts';
import { runDraftsAppend } from '../src/commands/drafts-append';
import { draftsHelpEntries, findDraftsCommand } from '../src/commands/index';
import type { CliContext } from '../src/core/context';
import { CliError } from '../src/lib/errors';
import { commandHelp } from '../src/lib/args';
import { createOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const RPC = 'http://127.0.0.1:8545';
const GENESIS: Hex = `0x${'ab'.repeat(32)}`;
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

interface SeamOptions {
  /** The module the Safe's enabled list answers for the drafts role. */
  enabled?: Address | null;
  /** The newest drafts proxy the factory index names. */
  factory?: Address | null;
  /** What `versionCount(genesis)` answers after the append. */
  versionCount?: bigint;
  /** Shared with the runner, so the asserts can say which call came first. */
  order?: string[];
}

/** The seam, with the version-count reads recorded, so the read-back is asserted. */
function fakeSeam(options: SeamOptions = {}) {
  const enabled = options.enabled === undefined ? MODULE : options.enabled;
  const versionReads: Hex[] = [];

  const seam: DraftsSeam = {
    readEnabled: () =>
      Promise.resolve({
        modules: enabled ? [enabled] : [],
        byRole: { drafts: enabled ? [enabled] : [], ownerHistory: [] },
        drafts: enabled,
        ownerHistory: null,
      }),
    readModuleSafe: () => Promise.resolve(SAFE),
    readFactory: () =>
      Promise.resolve({
        factory: FACTORY,
        drafts: options.factory ?? null,
        ownerHistory: null,
        guard: null,
      }),
    readCount: () => Promise.resolve(0n),
    readPage: () => Promise.resolve([]),
    readVersionCount: ({ genesis }) => {
      versionReads.push(genesis);
      options.order?.push('read');
      return Promise.resolve(options.versionCount ?? 1n);
    },
  };

  return { seam, versionReads };
}

type Send = (...args: unknown[]) => unknown;

interface CtxOptions {
  simulateContract?: ReturnType<typeof vi.fn>;
  /** The send the runner makes; the default resolves to a tx hash. */
  genericTx?: Send;
  order?: string[];
}

/** A context with only what the append touches: the RPC list, the L2 read, the runner. */
function fakeCtx(options: CtxOptions = {}) {
  const simulateContract = options.simulateContract ?? vi.fn().mockResolvedValue({});
  const sent: Send = options.genericTx ?? (() => Promise.resolve('0x' + '11'.repeat(32)));
  // Wrapped rather than passed through, so the call order is recorded even when
  // the caller supplied its own mock.
  const genericTx = vi.fn((...args: unknown[]) => {
    options.order?.push('tx');
    return sent(...args);
  });

  const ctx = {
    config: { author: { name: 'joera' }, contracts: {} },
    out: createOut(true),
    rpcs: { L1: [RPC], L2: [RPC] },
    l2: { simulateContract },
    authorRunner: () => Promise.resolve({ genericTx }),
  } as unknown as CliContext;

  return { ctx, simulateContract, genericTx };
}

const deployed = () => Promise.resolve({ address: SAFE, deployed: true });

describe('appendDraft', () => {
  it('sends append to the module the Safe enabled, from the Safe, with the bytes32 id', async () => {
    const { seam } = fakeSeam();
    const { ctx, simulateContract, genericTx } = fakeCtx();

    const draft = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, { seam, safeState: deployed });

    expect(genericTx).toHaveBeenCalledWith(
      MODULE,
      JSON.stringify(DraftsModuleV1),
      'append',
      [GENESIS, CID],
      false,
    );
    // The simulation goes as the Safe: that `from` is the msg.sender of the
    // deployed userOp, so `OnlySafe()` is caught before gas is spent.
    expect(simulateContract).toHaveBeenCalledWith({
      address: MODULE,
      abi: DraftsModuleV1,
      functionName: 'append',
      args: [GENESIS, CID],
      account: SAFE,
    });
    expect(draft).toEqual({
      module: MODULE,
      genesis: GENESIS,
      cid: CID,
      versionCount: 1,
      txHash: '0x' + '11'.repeat(32),
    });
  });

  it('converts a bare genesis with the same toBytes32Id makeOffer uses', async () => {
    const { seam } = fakeSeam();
    const { ctx, genericTx } = fakeCtx();

    await appendDraft(ctx, { genesis: 'note-1', cid: CID }, { seam, safeState: deployed });

    const sentArgs = genericTx.mock.calls[0]?.[3] as [Hex, string] | undefined;
    const id = sentArgs?.[0];
    expect(id).toBe(toBytes32Id('note-1'));
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sentArgs?.[1]).toBe(CID);
  });

  it('takes the version count from the module after the append, not from the caller', async () => {
    const order: string[] = [];
    const { seam, versionReads } = fakeSeam({ versionCount: 3n, order });
    const { ctx } = fakeCtx({ order });

    const draft = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, { seam, safeState: deployed });

    expect(draft.versionCount).toBe(3);
    expect(versionReads).toEqual([GENESIS]);
    // Read back, not computed: the send happened first, then the module was asked.
    expect(order).toEqual(['tx', 'read']);
  });

  it('drops the count, not the transaction, when the read-back fails', async () => {
    const { seam } = fakeSeam();
    const { ctx, genericTx } = fakeCtx();
    const flaky: DraftsSeam = {
      ...seam,
      readVersionCount: () => Promise.reject(new Error('HTTP request failed')),
    };

    const draft = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, {
      seam: flaky,
      safeState: deployed,
    });

    // The append landed; a failed read must not advise one that lands again.
    expect(genericTx).toHaveBeenCalledTimes(1);
    expect(draft.txHash).toBe('0x' + '11'.repeat(32));
    expect(draft.versionCount).toBeUndefined();
  });

  it('uses a module the caller resolved, without resolving it again', async () => {
    const { seam } = fakeSeam();
    const { ctx, genericTx } = fakeCtx();
    const never = (): never => {
      throw new Error('the enabled list was read a second time');
    };

    await appendDraft(
      ctx,
      {
        genesis: GENESIS,
        cid: CID,
        module: { address: MODULE, source: 'enabled', onEnabledList: true },
      },
      { seam: { ...seam, readEnabled: never, readModuleSafe: never }, safeState: deployed },
    );

    expect(genericTx).toHaveBeenCalledWith(
      MODULE,
      JSON.stringify(DraftsModuleV1),
      'append',
      [GENESIS, CID],
      false,
    );
  });

  it('names the install, the pinned bytes and the retry when no drafts module answers', async () => {
    const { seam } = fakeSeam({ enabled: null, factory: null });
    const { ctx, genericTx } = fakeCtx();

    const error = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, { seam, safeState: deployed })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain(`the bytes are pinned at ${CID}`);
    expect(message).toContain('the drafts log was not appended');
    expect(message).toContain('s2s author init');
    expect(message).toContain(`s2s drafts append ${GENESIS} ${CID}`);
    expect(genericTx).not.toHaveBeenCalled();
  });

  it('says the Safe is not deployed instead of letting a module read answer nothing', async () => {
    const { seam } = fakeSeam();
    const { ctx, genericTx } = fakeCtx();

    const error = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, {
      seam,
      safeState: () => Promise.resolve({ address: SAFE, deployed: false }),
    }).catch((err: unknown) => err);

    const message = (error as CliError).message;
    expect(message).toContain(`the author Safe ${SAFE} is not deployed`);
    expect(message).toContain('s2s author init');
    expect(message).toContain(`the bytes are pinned at ${CID}`);
    expect(genericTx).not.toHaveBeenCalled();
  });

  it('reports a simulated revert as pinned bytes, never as the raw viem error', async () => {
    const { seam } = fakeSeam();
    const simulateContract = vi
      .fn()
      .mockRejectedValue(new Error("Execution reverted with reason: custom error 'OnlySafe()'."));
    const { ctx, genericTx } = fakeCtx({ simulateContract });

    const error = await appendDraft(ctx, { genesis: GENESIS, cid: CID }, { seam, safeState: deployed })
      .catch((err: unknown) => err);

    const message = (error as CliError).message;
    expect(error).toBeInstanceOf(CliError);
    expect(message).toContain('would revert');
    expect(message).toContain(`the bytes are pinned at ${CID}`);
    expect(message).toContain(`s2s drafts append ${GENESIS} ${CID}`);
    // Nothing was sent: the pre-flight is what failed.
    expect(genericTx).not.toHaveBeenCalled();
  });
});

describe('s2s drafts append', () => {
  it('reports the version count the log answered', async () => {
    const { seam } = fakeSeam({ versionCount: 2n });
    const { ctx } = fakeCtx();
    const stdout: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });

    try {
      const result = await runDraftsAppend(ctx, GENESIS, CID, { seam, safeState: deployed });

      expect(result.action).toBe('drafts.append');
      expect(result.versionCount).toBe(2);
      const payload = JSON.parse(stdout.join('')) as Record<string, unknown>;
      expect(payload).toMatchObject({
        action: 'drafts.append',
        author: 'joera',
        module: MODULE,
        genesis: GENESIS,
        cid: CID,
        txHash: '0x' + '11'.repeat(32),
        versionCount: 2,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('is registered beside list, with its usage line', () => {
    const command = findDraftsCommand('append');
    expect(findDraftsCommand('list')?.name).toBe('list');
    expect(command?.name).toBe('append');
    expect(draftsHelpEntries.map((entry) => entry.name)).toEqual(['list', 'append']);
  });

  it('renders `s2s drafts append <genesis> <cid>` as its usage line', () => {
    const command = findDraftsCommand('append');

    const text = commandHelp(
      'drafts',
      command?.name ?? '',
      command?.summary ?? '',
      command?.flags ?? {},
      command?.params,
      command?.detail,
    );

    expect(text.split('\n')[0]).toBe('s2s drafts append <genesis> <cid> [flags]');
    // The detail is where the retry states what it is: the append an upload names.
    expect(text).toContain('retry');
    expect(text).toContain('version');
  });
});
