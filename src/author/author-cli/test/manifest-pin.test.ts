// ============================================================================
// The actions a publication runs are the ones its own pin names.
//
// The protocol's current document is not the publication's: a release reaches a
// publication when its `manifest_version` record moves, and a render that reads
// the current version dispatches whatever was live before the release. These
// cover the three answers — pinned elsewhere, pinned to the current version, no
// pin at all — and the cache, so one command asks the chain once.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getManifest } = vi.hoisted(() => ({ getManifest: vi.fn() }));

vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@s2s/soul2soul-shared')>();
  return { ...actual, getManifest };
});

import { manifestFor, type CliContext } from '../src/core/context';
import type { PublicationService } from '../src/core/service';

const CURRENT = {
  version: '0.1.3',
  litActions: { prep: 'QmCurrentPrep', render: 'QmCurrentRender', update: 'QmCurrentUpdate' },
} as unknown as CliContext['protocolInfo'];

const PINNED = {
  version: '0.1.4',
  litActions: { prep: 'QmPinnedPrep', render: 'QmPinnedRender', update: 'QmPinnedUpdate' },
} as unknown as CliContext['protocolInfo'];

const ctx = { l1: {}, l2: {}, protocolInfo: CURRENT } as unknown as CliContext;

const serviceWith = (manifestVersion: string | undefined) =>
  ({ manifestVersion }) as unknown as PublicationService;

describe('manifestFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the version the publication pins, not the current document', async () => {
    getManifest.mockResolvedValue(PINNED);

    const manifest = await manifestFor(ctx, serviceWith('0.1.4'));

    expect(getManifest).toHaveBeenCalledWith(ctx.l1, ctx.l2, '0.1.4');
    expect(manifest.litActions.prep).toBe('QmPinnedPrep');
  });

  it('asks once for a publication, then answers from the service', async () => {
    getManifest.mockResolvedValue(PINNED);
    const service = serviceWith('0.1.4');

    await manifestFor(ctx, service);
    await manifestFor(ctx, service);

    expect(getManifest).toHaveBeenCalledTimes(1);
  });

  it('keeps the current document when the pin names it', async () => {
    const manifest = await manifestFor(ctx, serviceWith('0.1.3'));

    expect(getManifest).not.toHaveBeenCalled();
    expect(manifest).toBe(CURRENT);
  });

  it('keeps the current document when the publication pins nothing', async () => {
    const manifest = await manifestFor(ctx, serviceWith(undefined));

    expect(getManifest).not.toHaveBeenCalled();
    expect(manifest).toBe(CURRENT);
  });
});
