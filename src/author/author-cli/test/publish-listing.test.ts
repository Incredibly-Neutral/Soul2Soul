// ============================================================================
// `s2s author publish` refuses when the author Safe's append would be an offer.
//
// The site serves agreements only, so an unlisted author's publish used to
// upload, pin, offer, render, and leave the note off the site. The gate runs
// before anything is signed or pinned, and the refusal names `s2s author offer`.
//
// The publication service, the author Safe's state and the drafts append are
// faked; the write path and the gate are real.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  serviceInit,
  authorListing,
  makeOffer,
  getMultiSig,
  resolveDraftsModule,
  appendDraft,
  renderwithLitActions,
} = vi.hoisted(() => ({
  serviceInit: vi.fn(),
  authorListing: vi.fn(),
  makeOffer: vi.fn(),
  getMultiSig: vi.fn(),
  resolveDraftsModule: vi.fn(),
  appendDraft: vi.fn(),
  renderwithLitActions: vi.fn(),
}));

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
  PublicationService: { init: serviceInit },
}));

vi.mock('../src/core/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/drafts')>();
  return { ...actual, resolveDraftsModule, appendDraft };
});

vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared')>();
  return { ...actual, renderwithLitActions };
});

import { authorSafeState } from '../src/core/author-safe';
import type { CliContext } from '../src/core/context';
import { parseCommandArgs } from '../src/lib/args';
import { publish } from '../src/commands/publish';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
// Deliberately not the author Safe: the refusal names both, in different roles.
const PUB_SAFE = '0x2222222222222222222222222222222222222222' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const EOA = '0x1111111111111111111111111111111111111111' as Address;
const RPC = 'http://127.0.0.1:8545';
const PUBLICATION = 'test.soul2soul.eth';
const OBJECT = 'bafyobject';
const ROOT = 'bafyroot';

interface Fakes {
  ctx: CliContext;
  order: string[];
  addToKubo: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  result: ReturnType<typeof vi.fn>;
}

function fakeCtx(order: string[]): Fakes {
  const addToKubo = vi.fn(() => {
    order.push('upload');
    return Promise.resolve(OBJECT);
  });
  const warn = vi.fn();
  const result = vi.fn();

  authorListing.mockImplementation(() => {
    order.push('listing');
    return Promise.resolve({ listed: true, via: 'whitelist' });
  });
  makeOffer.mockImplementation(() => {
    order.push('offer');
    return Promise.resolve('0x' + 'ff'.repeat(32));
  });
  appendDraft.mockImplementation((_ctx: unknown, opts: { genesis: string; cid: string }) =>
    Promise.resolve({
      module: MODULE,
      genesis: opts.genesis,
      cid: opts.cid,
      versionCount: 1,
      txHash: '0x' + '33'.repeat(32),
    }),
  );
  resolveDraftsModule.mockResolvedValue({ address: MODULE, source: 'enabled', onEnabledList: true });
  renderwithLitActions.mockResolvedValue({ success: true, cid: ROOT, path: '/note/' });

  const ctx = {
    config: { lit: { usageKey: 'k' }, filecoin: {}, ipfs: { primary: {} } },
    out: { json: false, log: vi.fn(), warn, result },
    rpcs: { L1: [RPC], L2: [RPC] },
    l1: {},
    l2: { simulateContract: vi.fn().mockResolvedValue({}) },
    l2Runner: { genericRead: vi.fn() },
    ensRegistry: EOA,
    protocolInfo: { pkp: '0x' + '44'.repeat(48) },
    eoaAddress: EOA,
    ipfs: {
      addToKubo,
      fetchFromKubo: () => Promise.resolve(undefined),
      backupToProviders: vi.fn().mockResolvedValue({ filebase: false, pinata: false, filecoin: 'skipped' }),
    },
    signer: {
      getAddress: () => EOA,
      signTypedData: () => Promise.resolve('0x' + '55'.repeat(65)),
      signMessage: () => Promise.resolve('0x' + '66'.repeat(65)),
    },
    authorRunner: () => Promise.resolve({ genericTx: vi.fn() }),
  } as unknown as CliContext;

  return { ctx, order, addToKubo, warn, result };
}

describe('publish requires a listing', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    serviceInit.mockResolvedValue({
      subdomain: 'test',
      getMultiSig,
      authorListing,
      makeOffer,
    });
    getMultiSig.mockReturnValue(PUB_SAFE);
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
    const dir = mkdtempSync(join(tmpdir(), 's2s-publish-listing-'));
    dirs.push(dir);
    const path = join(dir, 'note.md');
    writeFileSync(path, ['---', 'title: Hello', 'encrypted: false', '---', '', '# Hello', '', 'body'].join('\n'));
    return path;
  }

  function argsFor(path: string) {
    return parseCommandArgs(['--publication', PUBLICATION, path], publish.flags);
  }

  it('refuses an unlisted author before the pin, naming the offer command', async () => {
    const { ctx, order, addToKubo, result } = fakeCtx([]);
    authorListing.mockImplementation(() => {
      order.push('listing');
      return Promise.resolve({ listed: false });
    });
    const path = note();

    const err = await publish.run(ctx, argsFor(path)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'author_not_listed' });
    expect((err as Error).message).toContain('s2s author offer');

    // The check is the only thing that ran: no upload, no offer, no render.
    expect(order).toEqual(['listing']);
    expect(addToKubo).not.toHaveBeenCalled();
    expect(makeOffer).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it('the refusal names the note, the author Safe and the publication', async () => {
    const { ctx } = fakeCtx([]);
    authorListing.mockResolvedValue({ listed: false });
    const path = note();

    const err = await publish.run(ctx, argsFor(path)).catch((e: unknown) => e);
    const message = (err as Error).message;

    expect(message).toContain(`refusing to publish ${path}`);
    expect(message).toContain(`the author Safe ${SAFE}`);
    expect(message).toContain(`whitelisted author of ${PUBLICATION}`);
    // The author address is the one to whitelist; the publication Safe is the
    // one that can do it. Same address in both slots would hide a swap.
    expect(message).toContain(`publication Safe ${PUB_SAFE} whitelistAuthor(${SAFE})`);
  });

  it('publishes a listed author: listing read, then upload, then offer', async () => {
    const { ctx, order, result } = fakeCtx([]);
    const path = note();

    await publish.run(ctx, argsFor(path));

    expect(order).toEqual(['listing', 'upload', 'offer']);
    expect(makeOffer).toHaveBeenCalledWith(expect.any(String), OBJECT);
    expect(result).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'publish', note: path }),
      expect.stringContaining(`Published ${path}`),
    );
  });

  it('warns and continues when the listing read fails', async () => {
    const { ctx, order, warn, addToKubo } = fakeCtx([]);
    authorListing.mockRejectedValue(new Error('rpc down'));
    const path = note();

    await publish.run(ctx, argsFor(path));

    // A flaky read does not block the write; the simulation still guards it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PUBLICATION));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rpc down'));
    expect(addToKubo).toHaveBeenCalled();
    expect(order).toEqual(['upload', 'offer']);
  });
});
