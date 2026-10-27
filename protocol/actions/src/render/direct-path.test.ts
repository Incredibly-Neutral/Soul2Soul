/**
 * render/main.ts — direct read path: content identity + integrity.
 *
 * Contract under test:
 *   - a plaintext job body whose bytes are not the author-signed
 *     `public.plaintextHash` FAILS the job: ok:false, nothing rendered, signed
 *     or published (no fallback to the unverified body);
 *   - a verified plaintext body renders, and the metadata handed to
 *     addAndSignMetadata carries the REAL deal cid, the genesis, plaintextHash,
 *     mediaType, specVersion, the author did/proof and the author Safe — never
 *     `ipfs://0x…`;
 *   - a decrypted collection item whose plaintext does not match its signed
 *     hash is dropped NON-fatally (kind "data", fatal:false) like a decrypt
 *     failure, and the page still renders.
 *
 * Only the chain/IPFS edge is mocked: module.factory (and therefore the real
 * fetchById → fetchItemById → toBody path) runs for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5'; // protocol's v5 alias — render main needs ethers.utils (v5 semantics)

(globalThis as unknown as { ethers: unknown }).ethers = ethers;

vi.mock('../libs/evm', () => ({ evmRead: vi.fn(), evmWrite: vi.fn(), toHexString: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({
  catFile: vi.fn(),
  uploadFile: vi.fn(),
  decodeArchiveCid: vi.fn(() => ''),
}));
vi.mock('../libs/decrypt', () => ({ decryptRaw: vi.fn() }));
vi.mock('../libs/protocol.factory', () => ({ getProtocolInfo: vi.fn() }));
vi.mock('../libs/ens.factory', () => ({ getDomainOwnerAndModules: vi.fn() }));
vi.mock('../libs/gates', () => ({ extractSignerAddress: vi.fn() }));
vi.mock('../libs/helpers', () => ({
  requireFields: vi.fn(),
  setRpcAuth: vi.fn(),
  fetchWithTimeout: vi.fn(),
  addressToUserId: vi.fn(),
}));
vi.mock('./config.ctrl', () => ({ getConfig: vi.fn() }));
vi.mock('./data.ctrlr', () => ({
  initTemplateData: vi.fn(),
  fetchCollections: vi.fn(),
  mergeDecrypted: vi.fn(),
  pathsForCollections: vi.fn(),
  shouldWriteBackCache: vi.fn(),
}));
vi.mock('./metadata', () => ({ addAndSignMetadata: vi.fn() }));
vi.mock('../renderer/html.ctrlr', () => ({ renderHTML: vi.fn() }));

import { main } from './main';
import { evmRead } from '../libs/evm';
import { catFile, uploadFile } from '../libs/ipfs.factory';
import { decryptRaw } from '../libs/decrypt';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { extractSignerAddress } from '../libs/gates';
import { getConfig } from './config.ctrl';
import {
  initTemplateData,
  fetchCollections,
  mergeDecrypted,
  pathsForCollections,
  shouldWriteBackCache,
} from './data.ctrlr';
import { addAndSignMetadata } from './metadata';
import { renderHTML } from '../renderer/html.ctrlr';
import type { SingleInput, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';

// ── Fixtures ─────────────────────────────────────────────────────────────

const GENESIS = '0x' + '9a'.repeat(32);
const DEAL_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ENCRYPTED_CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const PUBLICATION = 'test.soul2soul.eth';
const AUTHOR = 'did:ethr:0x' + 'a'.repeat(40);
const AUTHOR_SIGNER = '0x' + 'b'.repeat(40);
const SIGNER = '0xSigner';
const AUTHOR_SAFE = '0xAuthorSafe';
const SIGNATURE = '0x' + 'ab'.repeat(65);
const SIGNED_CREATED_AT = 1700000000;

const PLAINTEXT = JSON.stringify({ content: 'Hello', custom: {}, slug: 'hello', title: 'Hello' });
const PLAINTEXT_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(PLAINTEXT));

const templateConfig = (collections: S2STemplateConfig['collections'] = []): S2STemplateConfig => ({
  reference: 'post',
  file: 'post.hbs',
  path: '/{slug}',
  collections,
});

const input = (collections: S2STemplateConfig['collections'] = []): SingleInput => ({
  job: { id: GENESIS, templateConfig: templateConfig(collections), html: '', path: '/hello' },
  signature: SIGNATURE,
  authorSafeAddress: AUTHOR_SAFE,
  publication: PUBLICATION,
  preview: true,
  endpoints: {
    ipfsGateway: 'https://ipfs.example',
    rpcs: { L1: ['https://rpc.l1'], L2: ['https://rpc.l2'] },
  },
});

/** The canonical content item stored at the deal cid. */
const contentItem = (body = PLAINTEXT) => ({
  public: {
    specVersion: '1',
    author: AUTHOR,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '0',
    publication: PUBLICATION,
    locale: 'en',
    createdAt: SIGNED_CREATED_AT,
    tags: [],
    plaintextHash: PLAINTEXT_HASH,
  },
  objectId: '0x' + 'de'.repeat(32),
  proof: { type: 'eip712', signer: AUTHOR_SIGNER, signature: SIGNATURE },
  encryption: false,
  body,
});

function setupHappyDeps() {
  vi.mocked(extractSignerAddress).mockReturnValue(SIGNER);
  vi.mocked(getProtocolInfo).mockResolvedValue({
    gateway: 'https://ipfs.example',
    ensRegistry: '0xensRegistry',
    ensRecords: '0xens',
    publicationFactory: '0xpubFactory',
    recordsFactory: '0xrecords',
    pkp: '0xpkp',
    litActions: { prep: 'cid-prep', render: 'cid-render', update: 'cid-update' },
  });
  vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
    multisig: '0xms',
    configModule: '0xcfg',
    publicationModule: '0xpub',
  });
  vi.mocked(getConfig).mockResolvedValue({
    mapping: { templateConfig: [], ripples: [] },
    localePaths: {},
  });
  vi.mocked(initTemplateData).mockResolvedValue({
    id: GENESIS,
    path: '/hello',
    revoked: false,
    title: 'Hello',
    slug: 'hello',
    content: 'Hello',
  });
  vi.mocked(fetchCollections).mockResolvedValue({ collections: {}, drift: null, skips: [] });
  vi.mocked(renderHTML).mockResolvedValue('<html><body>rendered</body></html>');
  vi.mocked(addAndSignMetadata).mockResolvedValue('<html><body>signed</body></html>');
  vi.mocked(uploadFile).mockResolvedValue('QmRenderedHtml');
  vi.mocked(shouldWriteBackCache).mockReturnValue(false);
  vi.mocked(pathsForCollections).mockReturnValue('/coll');
  vi.mocked(mergeDecrypted).mockImplementation(((
    body: Record<string, unknown>,
    decrypted: Record<string, unknown>,
  ) => ({
    ...body,
    ...decrypted,
    encryption: false,
  })) as unknown as typeof mergeDecrypted);

  // Chain: getLatest returns the deal; the ENS archive pointer is empty.
  vi.mocked(evmRead).mockImplementation(((
    _chain: string,
    _address: string,
    _abi: unknown,
    fn: string,
  ): Promise<unknown> => {
    if (fn === 'getLatest') {
      return Promise.resolve({
        genesis: GENESIS,
        author: '0xauthor',
        cid: DEAL_CID,
        timestamp: SIGNED_CREATED_AT,
      });
    }
    if (fn === 'getText') return Promise.resolve('');
    return Promise.reject(new Error(`unexpected evmRead: ${fn}`));
  }) as never);

  // IPFS: the deal cid resolves to the canonical content item.
  vi.mocked(catFile).mockResolvedValue(JSON.stringify(contentItem()));
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyDeps();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('render action — plaintext integrity (direct read path)', () => {
  it('fails the job and renders/publishes NOTHING when the body does not match plaintextHash', async () => {
    vi.mocked(catFile).mockResolvedValue(
      JSON.stringify(contentItem(JSON.stringify({ content: 'EXPLOIT', slug: 'hello' }))),
    );

    const result = await main(input());
    const failure = result as { ok: boolean; error?: string };

    expect(failure.ok).toBe(false);
    expect(failure.error).toContain('plaintext hash mismatch');
    expect(failure.error).toContain(DEAL_CID);
    // Never fall back to rendering the unverified body.
    expect(vi.mocked(renderHTML)).not.toHaveBeenCalled();
    expect(vi.mocked(addAndSignMetadata)).not.toHaveBeenCalled();
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
  });

  it('renders a verified plaintext body and hands the REAL identity to addAndSignMetadata', async () => {
    const result = await main(input());

    expect(result.ok).toBe(true);
    expect(vi.mocked(catFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);

    expect(vi.mocked(addAndSignMetadata)).toHaveBeenCalledTimes(1);
    const [id, , , metadata] = vi.mocked(addAndSignMetadata).mock.calls[0];

    expect(id).toBe(GENESIS);
    expect(metadata?.contentGenesis).toBe(GENESIS);
    // the real deal cid — never the bytes32 genesis, never `ipfs://0x…`
    expect(metadata?.contentCid).toBe(DEAL_CID);
    expect(metadata?.contentCid).not.toBe(GENESIS);
    expect(metadata?.plaintextHash).toBe(PLAINTEXT_HASH);
    expect(metadata?.mediaType).toBe('text/markdown');
    expect(metadata?.specVersion).toBe('1');
    expect(metadata?.author?.did).toBe(AUTHOR);
    expect(metadata?.author?.createdAt).toBe(String(SIGNED_CREATED_AT));
    expect(metadata?.author?.proof).toEqual(contentItem().proof);
    expect(metadata?.publisher?.did).toBe(`did:ethr:${SIGNER}`);
    expect(metadata?.publisher?.url).toBe(PUBLICATION);
    expect(metadata?.publisher?.safe).toBe(AUTHOR_SAFE);
    expect(metadata?.licenseContract).toBe('0xpub');

    const data = (result as { data?: { job?: { html?: string } } }).data;
    expect(data?.job?.html).toBe('QmRenderedHtml');
  });
});

describe('render action — decrypted integrity (encrypted collection items)', () => {
  const encryptedItem = {
    id: '0x' + '33'.repeat(32),
    cid: ENCRYPTED_CID,
    encryption: true,
    plaintextHash: PLAINTEXT_HASH,
    content: 'ciphertext-blob',
    author: AUTHOR,
    locale: 'en',
    postType: 'post',
    creationDate: '2026-01-01',
    publication: PUBLICATION,
    tags: [],
  };
  const collections = [{ slug: 'posts' }];

  beforeEach(() => {
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: { posts: [encryptedItem] as never },
      drift: null,
      skips: [],
    });
  });

  it('skips a corrupted decrypted plaintext NON-fatally and never renders it', async () => {
    const forged = JSON.stringify({ ...JSON.parse(PLAINTEXT), content: 'EXPLOIT' });
    vi.mocked(decryptRaw).mockResolvedValue({
      raw: forged,
      parsed: JSON.parse(forged) as never,
      rawFromDecryptor: true,
    });

    const result = await main(input(collections));

    expect(result.ok).toBe(true);
    const data = (result as { data?: { availability?: Record<string, unknown>[] } }).data;
    const entry = (data?.availability ?? []).find((a) => a.kind === 'data');
    if (!entry) throw new Error('expected a data availability entry');
    expect(entry.fatal).toBe(false);
    expect(entry.genesis).toBe(encryptedItem.id);
    expect(entry.cid).toBe(ENCRYPTED_CID);
    expect(String(entry.reason)).toContain('Plaintext hash mismatch');

    // dropped: the corrupted plaintext never reaches the template data
    const templateData = vi.mocked(renderHTML).mock.calls[0][2] as {
      collections: Record<string, unknown[]>;
    };
    expect(templateData.collections.posts).toEqual([]);
    expect(vi.mocked(mergeDecrypted)).not.toHaveBeenCalled();
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
  });

  it('keeps a decrypted plaintext that matches the signed hash', async () => {
    vi.mocked(decryptRaw).mockResolvedValue({
      raw: PLAINTEXT,
      parsed: JSON.parse(PLAINTEXT) as never,
      rawFromDecryptor: true,
    });

    const result = await main(input(collections));

    expect(result.ok).toBe(true);
    const data = (result as { data?: { availability?: unknown[] } }).data;
    expect(data?.availability).toBeUndefined();

    const templateData = vi.mocked(renderHTML).mock.calls[0][2] as {
      collections: Record<string, unknown[]>;
    };
    expect(templateData.collections.posts).toHaveLength(1);
    expect(vi.mocked(mergeDecrypted)).toHaveBeenCalledTimes(1);
  });

  it('rejects differently formatted but equivalent plaintext (hashes bytes, not the object)', async () => {
    // Same object, pretty-printed: NOT the bytes the author signed.
    const pretty = JSON.stringify(JSON.parse(PLAINTEXT), null, 2);
    vi.mocked(decryptRaw).mockResolvedValue({
      raw: pretty,
      parsed: JSON.parse(pretty) as never,
      rawFromDecryptor: true,
    });

    const result = await main(input(collections));

    expect(result.ok).toBe(true);
    const templateData = vi.mocked(renderHTML).mock.calls[0][2] as {
      collections: Record<string, unknown[]>;
    };
    expect(templateData.collections.posts).toEqual([]);
    expect(vi.mocked(mergeDecrypted)).not.toHaveBeenCalled();
  });

  it('accepts JCS-ordered plaintext with integer-like keys (JSON.stringify would reorder them)', async () => {
    const jcsBody = '{"content":"x","custom":{"10":"a","2":"b"}}';
    // the trap this test guards against: re-serialising reorders the keys
    expect(JSON.stringify(JSON.parse(jcsBody))).not.toBe(jcsBody);
    const jcsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(jcsBody));
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: {
        posts: [{ ...encryptedItem, plaintextHash: jcsHash }] as never,
      },
      drift: null,
      skips: [],
    });
    vi.mocked(decryptRaw).mockResolvedValue({
      raw: jcsBody,
      parsed: JSON.parse(jcsBody) as never,
      rawFromDecryptor: true,
    });

    const result = await main(input(collections));

    expect(result.ok).toBe(true);
    const data = (result as { data?: { availability?: unknown[] } }).data;
    expect(data?.availability).toBeUndefined();
    const templateData = vi.mocked(renderHTML).mock.calls[0][2] as {
      collections: Record<string, unknown[]>;
    };
    expect(templateData.collections.posts).toHaveLength(1);
  });

  it('surfaces a collection skip (forged body upstream) as a non-fatal data entry', async () => {
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: { posts: [] },
      drift: null,
      skips: [
        {
          genesis: encryptedItem.id,
          cid: ENCRYPTED_CID,
          reason: `plaintext hash mismatch for ${encryptedItem.id} (cid ${ENCRYPTED_CID}): the stored body does not match public.plaintextHash`,
          cause: 'integrity',
        },
      ] as never,
    });

    const result = await main(input(collections));

    expect(result.ok).toBe(true);
    const data = (result as { data?: { availability?: Record<string, unknown>[] } }).data;
    const entry = (data?.availability ?? []).find((a) => a.kind === 'data');
    if (!entry) throw new Error('expected a data availability entry');
    expect(entry.fatal).toBe(false);
    expect(entry.cid).toBe(ENCRYPTED_CID);
    expect(String(entry.reason)).toContain('plaintext hash mismatch');
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
  });
});
