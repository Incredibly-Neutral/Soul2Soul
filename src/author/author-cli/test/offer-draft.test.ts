// ============================================================================
// `s2s author offer --cid <cid>` appends the version it anchors, before it
// anchors it.
//
// The `--cid` path skips the upload, so it used to skip the drafts append that
// rides on an upload: the log lagged exactly the offer it was there to record.
// An offer now records its version first, and the pre-flight (a deployed Safe,
// a resolvable drafts module) runs before the offer's own simulation, so a
// missing module is not discovered from a transaction that already went out.
//
// Guards, chain reads and the publication service are faked; the append is the
// real one, driven through the same drafts seam `drafts-append.test.ts` uses.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial: `core/author-contracts.ts` pulls `ensureAuthorSafe` out of this module
// at import time, so only the reads this path makes are replaced.
vi.mock('../src/core/author-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/author-safe')>();
  return {
    ...actual,
    authorSafeState: vi.fn(),
    createAuthorWriteRunner: vi.fn(),
    givenSafeInUse: vi.fn(() => null),
  };
});

const { makeOffer } = vi.hoisted(() => ({ makeOffer: vi.fn() }));
vi.mock('../src/core/service', () => ({
  PublicationService: {
    init: vi.fn(async () => ({ subdomain: 'test', makeOffer })),
  },
}));

import { DraftsModuleV1 } from '@s2s/author-contracts';

import { offerContent } from '../src/core/author';
import { authorSafeState } from '../src/core/author-safe';
import type { CliContext } from '../src/core/context';
import type { DraftsSeam } from '../src/core/drafts';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const EOA = '0x1111111111111111111111111111111111111111' as Address;
const RPC = 'http://127.0.0.1:8545';
const GENESIS = '0x' + 'cd'.repeat(32);
const RECORDED = 'bafyrecorded';
const GIVEN = 'bafy--given';
const PUBLICATION = 'test.soul2soul.eth';

/**
 * The seam, with every read reported into `order` so the test can assert what
 * happened before what.
 */
function fakeSeam(order: string[], found: boolean): DraftsSeam {
  return {
    readEnabled: () => {
      order.push('resolve');
      return Promise.resolve({
        modules: found ? [MODULE] : [],
        byRole: { drafts: found ? [MODULE] : [], ownerHistory: [] },
        drafts: found ? MODULE : null,
        ownerHistory: null,
      });
    },
    readModuleSafe: () => Promise.resolve(SAFE),
    readFactory: () => {
      if (found) return Promise.resolve({ factory: FACTORY, drafts: null, ownerHistory: null, guard: null });
      // The index is the permissionless fallback: it names a module for another
      // Safe, which is a lead, not this Safe's log.
      return Promise.resolve({ factory: FACTORY, drafts: null, ownerHistory: null, guard: null });
    },
    readCount: () => Promise.resolve(1n),
    readPage: () => Promise.resolve([]),
    readVersionCount: () => Promise.resolve(4n),
  };
}

interface Fakes {
  ctx: CliContext;
  order: string[];
  genericTx: ReturnType<typeof vi.fn>;
  addToKubo: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

/**
 * A context whose only reachable chain call is the append's send. The previous
 * revision the downgrade guard reads is plaintext, so the guard passes.
 */
function fakeCtx(order: string[]): Fakes {
  const genericTx = vi.fn(() => {
    order.push('append');
    return Promise.resolve('0x' + '33'.repeat(32));
  });
  const addToKubo = vi.fn(() =>
    Promise.resolve(Promise.reject(new Error('offer must not upload')) as never),
  );
  const log = vi.fn();

  makeOffer.mockImplementation(() => {
    order.push('offer');
    return Promise.resolve('0x' + 'ff'.repeat(32));
  });

  const ctx = {
    config: { lit: { usageKey: 'k' }, filecoin: {}, ipfs: { primary: {} } },
    out: { json: false, log, warn: vi.fn(), result: vi.fn() },
    rpcs: { L1: [RPC], L2: [RPC] },
    l2: { simulateContract: vi.fn().mockResolvedValue({}) },
    protocolInfo: { pkp: '0x' + '44'.repeat(48) },
    eoaAddress: EOA,
    ipfs: {
      addToKubo,
      // The recorded revision: plaintext, in the current layout.
      fetchFromKubo: () =>
        Promise.resolve({ encryption: false, bodies: { s2s: JSON.stringify('{"title":"Hello"}') } }),
    },
    signer: {
      getAddress: () => EOA,
      signTypedData: async () => '0x' + '55'.repeat(65),
      signMessage: async () => '0x' + '66'.repeat(65),
    },
    authorRunner: () => Promise.resolve({ genericTx }),
  } as unknown as CliContext;

  return { ctx, order, genericTx, addToKubo, log };
}

describe('offer --cid records the version it anchors', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.mocked(authorSafeState).mockResolvedValue({
      address: SAFE,
      eoa: EOA,
      salt: null,
      safeSource: 'derived',
      chain: 'base',
      deployed: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function note(): string {
    const dir = mkdtempSync(join(tmpdir(), 's2s-offer-draft-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(
      path,
      [
        '---',
        'title: Hello',
        'encrypted: false',
        `genesis: "${GENESIS}"`,
        `cid: ${RECORDED}`,
        '---',
        '',
        '# Hello',
        '',
        'body',
      ].join('\n'),
    );
    return path;
  }

  it('appends the given cid and reports the draft', async () => {
    const { ctx, order, genericTx, addToKubo, log } = fakeCtx([]);
    const path = note();

    const result = await offerContent(ctx, path, PUBLICATION, GIVEN, {}, {
      draftsSeam: fakeSeam(order, true),
    });

    // The log got the genesis from the note and the cid exactly as given.
    expect(genericTx).toHaveBeenCalledWith(
      MODULE,
      JSON.stringify(DraftsModuleV1),
      'append',
      [GENESIS, GIVEN],
      false,
    );
    expect(result.draft).toEqual({
      module: MODULE,
      genesis: GENESIS,
      cid: GIVEN,
      versionCount: 4,
      txHash: '0x' + '33'.repeat(32),
    });
    expect(result.txHash).toBe('0x' + 'ff'.repeat(32));
    expect(log).toHaveBeenCalledWith(
      `✓ draft appended (${MODULE.slice(0, 8)}…, 4 versions in the log)`,
    );
    // The version is recorded before the offer, not after it.
    expect(order).toEqual(['resolve', 'append', 'offer']);
    // `--cid` still uploads nothing and re-pins nothing.
    expect(addToKubo).not.toHaveBeenCalled();
  });

  it('refuses a missing module before the offer is simulated', async () => {
    const { ctx, order, genericTx } = fakeCtx([]);
    const path = note();

    await expect(
      offerContent(ctx, path, PUBLICATION, GIVEN, { allowPlaintext: true }, {
        draftsSeam: fakeSeam(order, false),
      }),
    ).rejects.toMatchObject({ code: 'drafts_module' });

    expect(genericTx).not.toHaveBeenCalled();
    expect(makeOffer).not.toHaveBeenCalled();
    expect(order).toEqual(['resolve']);
  });
});
