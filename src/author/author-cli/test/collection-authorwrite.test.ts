// ============================================================================
// `authorWrite` turns a folder into one signed collection bundle.
//
// The mapping from a parsed note to the signing inputs is asserted in
// `collection-folder.test.ts`. This test proves the write path actually passes
// the loaded document through: the item handed to Kubo is the item the CLI
// signed, so a dropped `{ collection }` argument fails here.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapters/filecoin', () => ({
  createFilecoinStorage: () => Promise.resolve(undefined),
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
  PublicationService: {
    init: vi.fn(() =>
      Promise.resolve({
        subdomain: 'test',
        makeOffer: vi.fn(() => Promise.resolve('0x' + '22'.repeat(32))),
      }),
    ),
  },
}));

import {
  COLLECTION_MANIFEST_FILENAME,
  COLLECTION_MEDIA_TYPE,
  S2S_BODIES_KEY,
} from '@s2s/soul2soul-shared';

import { authorWrite } from '../src/core/author';
import { authorSafeState } from '../src/core/author-safe';
import type { CliContext } from '../src/core/context';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const EOA = '0x1111111111111111111111111111111111111111' as Address;
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PUBLICATION = 'test.soul2soul.eth';

interface CapturedItem {
  public: { mediaType: string };
  bodies: Record<string, string>;
}

interface CapturedBody {
  collection?: { slug: string; items: { key: string; slug: string }[] };
}

describe('authorWrite signs a folder as a collection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 's2s-collection-write-'));
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploads a bundle whose mediaType and body carry the member', async () => {
    writeFileSync(
      join(dir, COLLECTION_MANIFEST_FILENAME),
      '---\ntitle: Book\nslug: book\npost_type: chapter\nencrypted: false\n---\n\n# Book\n',
      'utf8',
    );
    writeFileSync(
      join(dir, '01-a.md'),
      '---\ntitle: First\nencrypted: false\n---\n\n# First\n',
      'utf8',
    );

    const addToKubo = vi.fn((_payload: string, _name: string) => Promise.resolve(CID as Hex));
    const ctx = {
      config: { lit: { usageKey: 'k' }, filecoin: {}, ipfs: { primary: {} } },
      out: { json: false, log: vi.fn(), warn: vi.fn(), result: vi.fn() },
      rpcs: { L1: ['http://127.0.0.1:8545'], L2: ['http://127.0.0.1:8545'] },
      eoaAddress: EOA,
      ipfs: { addToKubo },
      signer: {
        getAddress: () => EOA,
        signTypedData: () => Promise.resolve('0x' + '55'.repeat(65)),
        signMessage: () => Promise.resolve('0x' + '66'.repeat(65)),
      },
    } as unknown as CliContext;

    await authorWrite(ctx, join(dir, COLLECTION_MANIFEST_FILENAME), PUBLICATION, {
      render: false,
      publish: false,
      offer: false,
    });

    const payload = addToKubo.mock.calls[0]?.[0] ?? '';
    const item = JSON.parse(payload) as CapturedItem;
    expect(item.public.mediaType).toBe(COLLECTION_MEDIA_TYPE);

    const body = JSON.parse(item.bodies[S2S_BODIES_KEY] ?? '{}') as CapturedBody;
    expect(body.collection?.slug).toBe('book');
    expect(body.collection?.items.map((member) => member.key)).toEqual(['first']);
    expect(body.collection?.items[0]?.slug).toBe('first');
  });
});
