// ============================================================================
// authorWrite appends to the drafts log on a real write, and only then.
//
// The condition is `opts.publish`: upload, offer and publish set it, preview
// does not. What is under test is that one decision — the append's own call is
// asserted in `drafts-append.test.ts` — so the chain reads, the publication
// service and the render action are faked, and the drafts seam is the same fake
// the append tests use.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial: `core/author-contracts.ts` pulls `ensureAuthorSafe` out of this module
// at import time, so only the two reads this path makes are replaced.
vi.mock('../src/core/author-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/author-safe')>();
  return {
    ...actual,
    authorSafeState: vi.fn(),
    createAuthorWriteRunner: vi.fn(),
    givenSafeInUse: vi.fn(() => null),
  };
});

vi.mock('../src/core/service', () => ({
  PublicationService: {
    init: vi.fn(async () => ({
      subdomain: 'test',
      makeOffer: vi.fn(async () => '0x' + '22'.repeat(32)),
    })),
  },
}));

// The render action talks to Lit nodes; everything else in shared stays real, so
// the signed item is the item the CLI actually builds.
vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared')>();
  return {
    ...actual,
    renderwithLitActions: vi.fn(async () => ({
      success: true,
      cid: 'bafyroot',
      path: '/note/',
      trace: [],
    })),
  };
});

import { DraftsModuleV1 } from '@s2s/author-contracts';

import { authorWrite } from '../src/core/author';
import { authorSafeState } from '../src/core/author-safe';
import type { DraftsSeam } from '../src/core/drafts';
import type { CliContext } from '../src/core/context';
import type { CliError } from '../src/lib/errors';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as Address;
const EOA = '0x1111111111111111111111111111111111111111' as Address;
const RPC = 'http://127.0.0.1:8545';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PUBLICATION = 'test.soul2soul.eth';

/** The drafts seam the append resolves its module through. */
function fakeSeam(versionCount: bigint): DraftsSeam {
  return {
    readEnabled: () =>
      Promise.resolve({
        modules: [MODULE],
        byRole: { drafts: [MODULE], ownerHistory: [] },
        drafts: MODULE,
        ownerHistory: null,
      }),
    readModuleSafe: () => Promise.resolve(SAFE),
    readFactory: () =>
      Promise.resolve({ factory: FACTORY, drafts: null, ownerHistory: null, guard: null }),
    readCount: () => Promise.resolve(1n),
    readPage: () => Promise.resolve([]),
    readVersionCount: () => Promise.resolve(versionCount),
  };
}

interface Fakes {
  ctx: CliContext;
  genericTx: ReturnType<typeof vi.fn>;
  addToKubo: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function fakeCtx(): Fakes {
  const genericTx = vi.fn().mockResolvedValue('0x' + '33'.repeat(32));
  const addToKubo = vi.fn(async () => CID as Hex);
  const log = vi.fn();

  const ctx = {
    config: { lit: { usageKey: 'k' }, filecoin: {}, ipfs: { primary: {} } },
    out: { json: false, log, warn: vi.fn(), result: vi.fn() },
    rpcs: { L1: [RPC], L2: [RPC] },
    l2: { simulateContract: vi.fn().mockResolvedValue({}) },
    protocolInfo: { pkp: '0x' + '44'.repeat(48) },
    eoaAddress: EOA,
    ipfs: {
      addToKubo,
      backupToProviders: async () => ({ filebase: true, pinata: true, filecoin: 'ok' as const }),
    },
    signer: {
      getAddress: () => EOA,
      signTypedData: async () => '0x' + '55'.repeat(65),
      signMessage: async () => '0x' + '66'.repeat(65),
    },
    authorRunner: () => Promise.resolve({ genericTx }),
  } as unknown as CliContext;

  return { ctx, genericTx, addToKubo, log };
}

describe('authorWrite appends to the drafts log', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 's2s-drafts-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, '---\ntitle: Hello\nencrypted: false\n---\n\nbody\n');
    return path;
  }

  it('appends the uploaded cid and reports the log count', async () => {
    const { ctx, genericTx, log } = fakeCtx();
    const path = note();

    const result = await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: false, publish: true, offer: false },
      { draftsSeam: fakeSeam(4n) },
    );

    // The objectId is the genesis of a first upload, so the log is keyed by it.
    expect(genericTx).toHaveBeenCalledWith(
      MODULE,
      JSON.stringify(DraftsModuleV1),
      'append',
      [result.objectId, CID],
      false,
    );
    expect(result.draft).toEqual({
      module: MODULE,
      genesis: result.objectId,
      cid: CID,
      versionCount: 4,
      txHash: '0x' + '33'.repeat(32),
    });
    expect(log).toHaveBeenCalledWith(
      `✓ draft appended (${MODULE.slice(0, 8)}…, 4 versions in the log)`,
    );
    // The write-back still records the upload the append named.
    expect(readFileSync(path, 'utf8')).toContain(`cid: ${CID}`);
  });

  it('appends before the offer, so a failed offer leaves the version recorded', async () => {
    const { ctx, genericTx } = fakeCtx();
    const path = note();

    await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: false, publish: true, offer: true },
      { draftsSeam: fakeSeam(1n) },
    );

    // Two sends: `append` first, then `makeOffer`.
    const methods = vi.mocked(genericTx).mock.calls.map((call) => call[2]);
    expect(methods).toEqual(['append']);
  });

  it('writes the identity block before the append, so nothing is left orphaned', async () => {
    const { ctx, genericTx } = fakeCtx();
    const path = note();
    // The note as the module's send sees it: genesis and author already there.
    const seen: string[] = [];
    genericTx.mockImplementation(async () => {
      seen.push(readFileSync(path, 'utf8'));
      return '0x' + '33'.repeat(32);
    });

    const result = await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: false, publish: true, offer: true },
      { draftsSeam: fakeSeam(1n) },
    );

    const atAppend = seen[0] ?? '';
    expect(atAppend).toContain(result.objectId);
    expect(atAppend).toContain(SAFE);
    // The upload's own CID is written after the offer, so it is not there yet.
    expect(atAppend).not.toContain(CID);
    // Both halves land: the identity keys once, the upload keys once.
    const final = readFileSync(path, 'utf8');
    expect(final).toContain(result.objectId);
    expect(final).toContain(CID);
  });

  it('refuses an undeployed Safe before pinning anything', async () => {
    vi.mocked(authorSafeState).mockResolvedValue({
      address: SAFE,
      eoa: EOA,
      salt: null,
      safeSource: 'derived',
      chain: 'base',
      deployed: false,
    });
    const { ctx, addToKubo, genericTx } = fakeCtx();
    const path = note();

    const error = await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: false, publish: true, offer: false },
      { draftsSeam: fakeSeam(1n) },
    ).catch((err: unknown) => err);

    expect((error as CliError).code).toBe('author_safe');
    expect((error as Error).message).toContain('s2s author init');
    expect(addToKubo).not.toHaveBeenCalled();
    expect(genericTx).not.toHaveBeenCalled();
    // No key was written: nothing was uploaded, so nothing is half-recorded.
    expect(readFileSync(path, 'utf8')).not.toContain('genesis:');
  });

  it('resolves the drafts module before pinning, so a missing install uploads nothing', async () => {
    const { ctx, addToKubo, genericTx } = fakeCtx();
    const path = note();
    const noModule: DraftsSeam = {
      ...fakeSeam(1n),
      readEnabled: () =>
        Promise.resolve({
          modules: [],
          byRole: { drafts: [], ownerHistory: [] },
          drafts: null,
          ownerHistory: null,
        }),
      readModuleSafe: () => Promise.resolve(null),
    };

    const error = await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: false, publish: true, offer: false },
      { draftsSeam: noModule },
    ).catch((err: unknown) => err);

    expect((error as CliError).code).toBe('drafts_module');
    expect((error as Error).message).toContain('s2s author init');
    expect(addToKubo).not.toHaveBeenCalled();
    expect(genericTx).not.toHaveBeenCalled();
  });

  it('does not touch the log on a preview', async () => {
    const { ctx, genericTx } = fakeCtx();
    const path = note();

    const result = await authorWrite(
      ctx,
      path,
      PUBLICATION,
      { render: true, publish: false, offer: false },
      { draftsSeam: fakeSeam(1n) },
    );

    expect(genericTx).not.toHaveBeenCalled();
    expect(result.draft).toBeUndefined();
    // The preview still uploaded and rendered — only the log write is skipped.
    expect(result.kuboCid).toBe(CID);
    expect(result.render?.cid).toBe('bafyroot');
  });
});
