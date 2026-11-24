// ============================================================================
// The preview wiring: which mode reaches the renderer, and when the gate is
// asked at all.
//
// `previewMode` and `renderContent` are driven directly with a fake context.
// The gate and the renderer are mocked, so the assertions are about the CLI's
// own choices, not about chain reads or Lit.
// ============================================================================

import type { Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { canPreview, renderwithLitActions } = vi.hoisted(() => ({
  canPreview: vi.fn(),
  renderwithLitActions: vi.fn(),
}));

vi.mock('@s2s/soul2soul-shared/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared/gates')>();
  return { ...actual, canPreview };
});

vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared')>();
  return { ...actual, renderwithLitActions };
});

import type { ParsedNote, S2SManifest } from '@s2s/soul2soul-shared';

import {
  publishedVersionEncryption,
  previewMode,
  renderContent,
} from '../src/core/author';
import type { CliContext } from '../src/core/context';
import {
  UNSIGNED_PREVIEW_NOTICE,
  previousStateUnreadableNotice,
  previewRefusedNotice,
} from '../src/core/preview-mode';
import type { PublicationService } from '../src/core/service';

const EOA = '0x1111111111111111111111111111111111111111' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const MODULE = '0x0000000000000000000000000000000000000011' as Address;
const GENESIS = '0x' + 'ab'.repeat(32);
const PUBLICATION = 'test.soul2soul.eth';
const ROOT = 'bafyroot';

const service = {
  subdomain: 'test',
  publicationModule: MODULE,
  manifestVersion: 'v1',
} as unknown as PublicationService;

function manifest(unsignedRender: boolean): S2SManifest {
  return { version: 'v1', capabilities: { unsignedRender } } as unknown as S2SManifest;
}

function fakeCtx(): CliContext {
  return {
    config: { lit: { usageKey: 'k' }, ipfs: { primary: {} } },
    out: { json: false, log: vi.fn(), warn: vi.fn(), result: vi.fn() },
    rpcs: { L1: ['http://127.0.0.1:8545'], L2: ['http://127.0.0.1:8545'] },
    l1: {},
    l2: { readContract: vi.fn() },
    l2Runner: { genericRead: vi.fn() },
    ensRegistry: EOA,
    protocolInfo: manifest(true),
    eoaAddress: EOA,
    ipfs: {
      fetchFromKubo: vi.fn(),
      addToKubo: vi.fn(),
      backupToProviders: vi.fn(),
    },
    signer: { signMessage: vi.fn().mockResolvedValue('0xsig') },
    lit: {},
    authorRunner: vi.fn(),
  } as unknown as CliContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  canPreview.mockResolvedValue(true);
  renderwithLitActions.mockResolvedValue({ success: true, cid: ROOT, path: '/note/' });
});

describe('previewMode', () => {
  it('does not ask the gate for a publish', async () => {
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: true },
      true,
      manifest(true),
    );
    expect(choice).toEqual({ mode: 'publish' });
    expect(canPreview).not.toHaveBeenCalled();
  });

  it('does not ask the gate for a plaintext preview', async () => {
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: false },
      false,
      manifest(true),
    );
    expect(choice).toEqual({ mode: 'dev' });
    expect(canPreview).not.toHaveBeenCalled();
  });

  it('asks the gate for an encrypted preview and renders on Lit when admitted', async () => {
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: true },
      false,
      manifest(true),
    );
    expect(canPreview).toHaveBeenCalledTimes(1);
    expect(canPreview).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      GENESIS,
      MODULE,
      EOA,
      expect.any(Function),
    );
    expect(choice).toEqual({ mode: 'preview' });
  });

  it('takes dev with the pin line when the capability is absent', async () => {
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: true },
      false,
      manifest(false),
    );
    expect(choice).toEqual({ mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE });
  });

  it('takes dev with the address-specific refusal when not admitted', async () => {
    canPreview.mockResolvedValue(false);
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: true },
      false,
      manifest(true),
    );
    expect(choice).toEqual({ mode: 'dev', notice: previewRefusedNotice(EOA) });
  });

  it('does not ask the gate when the published version is unreadable', async () => {
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: false, unreadable: { reason: 'the gateway read timed out' } },
      false,
      manifest(true),
    );
    expect(canPreview).not.toHaveBeenCalled();
    expect(choice).toEqual({
      mode: 'dev',
      notice: previousStateUnreadableNotice('the gateway read timed out'),
    });
  });

  it('says it could not ask the gate when canPreview throws', async () => {
    canPreview.mockRejectedValue(new Error('rpc down'));
    const choice = await previewMode(
      fakeCtx(),
      service,
      GENESIS,
      { encrypted: true },
      false,
      manifest(true),
    );
    expect(choice).toEqual({ mode: 'dev', notice: 'could not ask the preview gate: rpc down' });
  });
});

describe('renderContent', () => {
  it('passes the chosen preview mode to renderwithLitActions', async () => {
    await renderContent(
      fakeCtx(),
      service,
      PUBLICATION,
      GENESIS,
      SAFE,
      { render: true, publish: false, offer: false },
      { encrypted: true },
    );
    expect(renderwithLitActions.mock.calls[0]?.[0]).toBe('preview');
  });

  it('passes publish unchanged, without asking the gate', async () => {
    await renderContent(
      fakeCtx(),
      service,
      PUBLICATION,
      GENESIS,
      SAFE,
      { render: true, publish: true, offer: false },
      { encrypted: true },
    );
    expect(renderwithLitActions.mock.calls[0]?.[0]).toBe('publish');
    expect(canPreview).not.toHaveBeenCalled();
  });

  it('prints the unreadable line and passes dev', async () => {
    const ctx = fakeCtx();
    await renderContent(
      ctx,
      service,
      PUBLICATION,
      GENESIS,
      SAFE,
      { render: true, publish: false, offer: false },
      { encrypted: false, unreadable: { reason: 'stale cid' } },
    );
    expect(renderwithLitActions.mock.calls[0]?.[0]).toBe('dev');
    expect(ctx.out.warn).toHaveBeenCalledWith(previousStateUnreadableNotice('stale cid'));
  });
});

describe('publishedVersionEncryption', () => {
  const note = (frontmatter: Record<string, unknown>): ParsedNote =>
    ({ genesis: GENESIS, contentId: null, frontmatter }) as unknown as ParsedNote;

  it('reads the encryption state from the version already published', async () => {
    const ctx = fakeCtx();
    vi.mocked(ctx.ipfs.fetchFromKubo).mockResolvedValue({ encryption: true });
    expect(await publishedVersionEncryption(ctx, note({ cid: 'bafyold' }), 'note.md')).toEqual({
      encrypted: true,
    });
    expect(ctx.ipfs.fetchFromKubo).toHaveBeenCalledWith('bafyold');
  });

  it('reports the classified read failure instead of guessing', async () => {
    const ctx = fakeCtx();
    vi.mocked(ctx.ipfs.fetchFromKubo).mockRejectedValue(
      new Error('Failed to fetch from IPFS: 404 Not Found'),
    );
    const state = await publishedVersionEncryption(ctx, note({ cid: 'bafyold' }), 'note.md');
    expect(state.encrypted).toBe(false);
    expect(state.unreadable?.reason).toContain('does not resolve');
  });

  it('reports a note with no recorded version as unreadable', async () => {
    const ctx = fakeCtx();
    const state = await publishedVersionEncryption(ctx, note({}), 'note.md');
    expect(state.unreadable?.reason).toContain('no published version');
    expect(ctx.ipfs.fetchFromKubo).not.toHaveBeenCalled();
  });
});
