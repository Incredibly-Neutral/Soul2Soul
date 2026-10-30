/**
 * module.factory — content identity carried onto the flat body + direct-read
 * integrity checks.
 *
 * Contract under test:
 *   - toBody keeps every legacy field and ADDITIVELY carries cid/objectId/
 *     plaintextHash/specVersion/mediaType/proof;
 *   - legacy items (no identity envelope) neither throw nor get identity fields;
 *   - fetchItemById performs exactly ONE cat and returns entry + item;
 *   - fetchById is fetchItemById + toBody (one cat, undefined when no cid);
 *   - an item that fails the integrity verdict (hash / author / objectId /
 *     proof — the ONE verdict in item-integrity.ts, shared with the archive
 *     path) THROWS ContentIntegrityError (the caller must fail the job, never
 *     render it);
 *   - an item the verdict can only call 'unverifiable' (legacy item, encrypted
 *     body, no typed-data signer in the runtime, contract-authored signer) is
 *     SERVED, and the doubt is logged once per code;
 *   - the COLLECTION readers (fetchByPublication*, incl. the archive drift
 *     refetch) go through the same choke point: a forged body is never a body,
 *     only an ItemSkip whose `cause` distinguishes integrity from unavailable;
 *   - one predicate decides what is plaintext (an item that omits `encryption`
 *     is plaintext, exactly as toBody flattens it);
 *   - verifyDecryptedBody hashes the decryptor's RAW STRING — never a
 *     re-serialisation, which both rejects JCS-ordered items with integer-like
 *     keys and accepts differently formatted forgeries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5';

vi.mock('./evm', () => ({ evmRead: vi.fn() }));
vi.mock('./ipfs.factory', () => ({ catFile: vi.fn() }));

import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
import {
  ContentIntegrityError,
  fetchById,
  fetchByPublicationDetailed,
  fetchByPublicationWithSkips,
  fetchItemById,
  isPlaintextItem,
  toBody,
  verifyDecryptedBody,
  type Entry,
  type StoredContentItem,
} from './module.factory';

const GENESIS = '0x' + '11'.repeat(32);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const AUTHOR = ('did:ethr:0x' + 'a'.repeat(40)) as `did:ethr:0x${string}`;
const GATEWAY = 'https://ipfs.example';
const PUBLICATION_MODULE = '0xPubModule';

const PLAINTEXT = JSON.stringify({ content: 'Hello', custom: {}, slug: 'hello', title: 'Hello' });
const PLAINTEXT_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(PLAINTEXT));

const ENTRY: Entry = { genesis: GENESIS, author: '0xauthor', cid: CID, timestamp: 1700000000 };

const mkItem = (overrides: Partial<StoredContentItem> = {}): StoredContentItem => ({
  public: {
    specVersion: '1',
    author: AUTHOR,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '0',
    publication: 'test.soul2soul.eth',
    locale: 'en',
    createdAt: 1700000000,
    tags: [],
    plaintextHash: PLAINTEXT_HASH,
  },
  objectId: '0x' + 'de'.repeat(32),
  proof: {
    type: 'eip712',
    signer: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    signature: ('0x' + 'cc'.repeat(65)) as `0x${string}`,
  },
  encryption: false,
  body: PLAINTEXT,
  ...overrides,
});

/** A pre-specVersion-1 item: no objectId/proof/plaintextHash/specVersion/mediaType. */
const legacyItem = (body = PLAINTEXT): StoredContentItem => ({
  public: {
    author: AUTHOR,
    postType: 'post',
    parent: '',
    position: '0',
    publication: 'test.soul2soul.eth',
    locale: 'en',
    createdAt: 1600000000,
    tags: [],
  },
  encryption: false,
  body,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toBody — additive identity', () => {
  it('carries cid/objectId/plaintextHash/specVersion/mediaType/proof alongside the legacy fields', () => {
    const item = mkItem();
    const body = toBody(ENTRY, item);

    // identity (new)
    expect(body.cid).toBe(CID);
    expect(body.objectId).toBe(item.objectId);
    expect(body.plaintextHash).toBe(PLAINTEXT_HASH);
    expect(body.specVersion).toBe('1');
    expect(body.mediaType).toBe('text/markdown');
    expect(body.proof).toEqual(item.proof);

    // legacy shape is untouched: same names, same values
    expect(body.id).toBe(GENESIS);
    expect(body.author).toBe(AUTHOR);
    expect(body.locale).toBe('en');
    expect(body.postType).toBe('post');
    expect(body.creationDate).toBe('1700000000');
    expect(body.modifiedDate).toBe('1700000000');
    expect(body.publication).toBe('test.soul2soul.eth');
    expect(body.encryption).toBe(false);
    expect(body.title).toBe('Hello');
    expect(body.slug).toBe('hello');
    expect(body.content).toBe('Hello');
    expect(body.custom).toEqual({});
  });

  it('carries identity on an encrypted body too (ciphertext stays in content)', () => {
    const item = mkItem({ encryption: true, body: 'ciphertext-blob' });
    const body = toBody(ENTRY, item);

    expect(body.encryption).toBe(true);
    expect(body.content).toBe('ciphertext-blob');
    expect(body.cid).toBe(CID);
    expect(body.plaintextHash).toBe(PLAINTEXT_HASH);
    expect(body.proof).toEqual(item.proof);
  });

  it('does not throw on a legacy item and leaves missing identity undefined', () => {
    const body = toBody(ENTRY, legacyItem());

    expect(body.id).toBe(GENESIS);
    expect(body.title).toBe('Hello');
    // the deal cid is always known; the per-item identity fields are absent
    expect(body.cid).toBe(CID);
    expect(body.objectId).toBeUndefined();
    expect(body.plaintextHash).toBeUndefined();
    expect(body.specVersion).toBeUndefined();
    expect(body.mediaType).toBeUndefined();
    expect(body.proof).toBeUndefined();
  });
});

describe('fetchItemById', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockResolvedValue(ENTRY);
  });

  it('cats exactly once and returns both the deal entry and the content item', async () => {
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(mkItem()));

    const res = await fetchItemById(GENESIS, PUBLICATION_MODULE, ['https://rpc.l2'], GATEWAY);
    if (!res) throw new Error('expected a fetched item');

    expect(res.entry).toEqual(ENTRY);
    expect(res.item.objectId).toBe('0x' + 'de'.repeat(32));
    expect(res.item.public.plaintextHash).toBe(PLAINTEXT_HASH);
    expect(vi.mocked(catFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(catFile)).toHaveBeenCalledWith(GATEWAY, CID);
    expect(vi.mocked(evmRead)).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (and cats nothing) when the module has no cid', async () => {
    vi.mocked(evmRead).mockResolvedValue({ ...ENTRY, cid: '' });

    const res = await fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY);

    expect(res).toBeUndefined();
    expect(vi.mocked(catFile)).not.toHaveBeenCalled();
  });

  it('accepts a plaintext item whose body matches plaintextHash', async () => {
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(mkItem()));

    await expect(
      fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY),
    ).resolves.toBeDefined();
  });

  it('throws ContentIntegrityError for a plaintext body that does not match plaintextHash', async () => {
    const forged = mkItem({ body: JSON.stringify({ content: 'EXPLOIT', slug: 'hello' }) });
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(forged));

    const err = await fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ContentIntegrityError);
    expect((err as ContentIntegrityError).genesis).toBe(GENESIS);
    expect((err as ContentIntegrityError).cid).toBe(CID);
    expect((err as Error).message).toContain('hash-mismatch');
    expect((err as Error).message).toContain(CID);
  });

  it('does not fail a legacy plaintext item that has no plaintextHash', async () => {
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(legacyItem()));

    await expect(
      fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY),
    ).resolves.toBeDefined();
  });

  it('does not run the plaintext check on an encrypted item (body is ciphertext)', async () => {
    vi.mocked(catFile).mockResolvedValue(
      JSON.stringify(mkItem({ encryption: true, body: 'ciphertext-blob' })),
    );

    await expect(
      fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY),
    ).resolves.toBeDefined();
  });
});

describe('fetchById', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockResolvedValue(ENTRY);
  });

  it('is exactly one cat and returns the flat toBody shape', async () => {
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(mkItem()));

    const body = await fetchById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY);

    expect(vi.mocked(catFile)).toHaveBeenCalledTimes(1);
    expect(body).toEqual(toBody(ENTRY, mkItem()));
    expect(body.cid).toBe(CID);
  });

  it('propagates the integrity failure — no flat body is produced for a forged body', async () => {
    vi.mocked(catFile).mockResolvedValue(
      JSON.stringify(mkItem({ body: JSON.stringify({ content: 'EXPLOIT' }) })),
    );

    await expect(fetchById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY)).rejects.toBeInstanceOf(
      ContentIntegrityError,
    );
    expect(vi.mocked(catFile)).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when there is no cid', async () => {
    vi.mocked(evmRead).mockResolvedValue({ ...ENTRY, cid: '' });

    await expect(
      fetchById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY),
    ).resolves.toBeUndefined();
    expect(vi.mocked(catFile)).not.toHaveBeenCalled();
  });
});

describe('verifyDecryptedBody — raw bytes only, verdict not boolean', () => {
  // The verdict is the SAME vocabulary the archive / item verdict uses, so the
  // render page path can distinguish "tampered" (fail the job) from "cannot
  // check" (a doubt: warn and render) exactly as data.ctrlr does.
  it('accepts the raw plaintext string that hashes to the signed plaintextHash', () => {
    expect(verifyDecryptedBody(mkItem(), PLAINTEXT)).toBe('verified');
  });

  it('accepts a flat toBody body (identity carried on the flat shape)', () => {
    expect(
      verifyDecryptedBody(toBody(ENTRY, mkItem({ encryption: true, body: 'ct' })), PLAINTEXT),
    ).toBe('verified');
  });

  it('accepts JCS-ordered plaintext with integer-like keys that JSON.stringify would reorder', () => {
    // JCS sorts keys lexically: "10" before "2". JSON.stringify emits them
    // numerically ("2" before "10"), so hashing a re-serialisation would FAIL a
    // correctly signed item. Raw bytes are the only thing that passes.
    const jcsBody = '{"content":"x","custom":{"10":"a","2":"b"}}';
    const jcsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(jcsBody));
    expect(JSON.stringify(JSON.parse(jcsBody))).not.toBe(jcsBody); // the trap is real
    expect(verifyDecryptedBody({ public: { plaintextHash: jcsHash } }, jcsBody)).toBe('verified');
  });

  it('rejects differently formatted but equivalent plaintext (pretty-printed)', () => {
    const pretty = JSON.stringify(JSON.parse(PLAINTEXT), null, 2);
    expect(pretty).not.toBe(PLAINTEXT);
    // same object, different bytes ⇒ not the bytes the author hashed
    expect(verifyDecryptedBody(mkItem(), pretty)).toBe('mismatch');
  });

  it('rejects decrypted plaintext that does not match the signed hash', () => {
    const forged = JSON.stringify({ ...JSON.parse(PLAINTEXT), content: 'EXPLOIT' });
    expect(verifyDecryptedBody(mkItem(), forged)).toBe('mismatch');
  });

  it("returns 'uncheckable' (nothing to check) for a legacy item without a plaintextHash", () => {
    expect(verifyDecryptedBody(legacyItem(), undefined)).toBe('uncheckable');
    expect(verifyDecryptedBody(legacyItem(), 'anything')).toBe('uncheckable');
  });

  it("returns 'weak' for a plaintextHash that is not a keccak digest (a doubt, not a forgery)", () => {
    // Same carve-out as inspectItemIntegrity: a third-party hash algorithm is
    // 'hash-malformed' there and served as unverifiable. Failing it here would
    // drop such an item from collections AND fail the page job — the two paths
    // would disagree about the same item.
    expect(verifyDecryptedBody({ public: { plaintextHash: 'sha256:abc' } }, PLAINTEXT)).toBe(
      'weak',
    );
  });

  it('fails closed for a parsed object / null / undefined when a hash is expected', () => {
    const parsed = JSON.parse(PLAINTEXT) as Record<string, unknown>;
    expect(verifyDecryptedBody(mkItem(), parsed)).toBe('mismatch');
    expect(verifyDecryptedBody(mkItem(), undefined)).toBe('mismatch');
    expect(verifyDecryptedBody(mkItem(), null)).toBe('mismatch');
  });

  it('is case-insensitive on the expected hex digest', () => {
    const upper = PLAINTEXT_HASH.toUpperCase().replace('0X', '0x');
    expect(verifyDecryptedBody({ public: { plaintextHash: upper } }, PLAINTEXT)).toBe('verified');
  });
});

describe('isPlaintextItem — the one predicate', () => {
  it('treats a missing `encryption` field as plaintext, like toBody always has', () => {
    expect(isPlaintextItem({})).toBe(true);
    expect(isPlaintextItem({ encryption: false })).toBe(true);
    expect(isPlaintextItem({ encryption: true })).toBe(false);
  });

  it('an item that omits `encryption` is MALFORMED, not a plaintext body (the shared shape gate)', async () => {
    // `encryption` is required by s2sContentItemSchema, and the archive door has
    // always refused an item without it. The direct door now runs the SAME gate
    // instead of quietly treating the missing flag as "plaintext" and hashing
    // `body` — which would make the two doors disagree about the same bytes.
    vi.mocked(evmRead).mockResolvedValue(ENTRY);
    const { encryption: _dropped, ...noFlag } = mkItem({
      body: JSON.stringify({ content: 'FORGED' }),
    });
    void _dropped;
    expect('encryption' in noFlag).toBe(false);
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(noFlag));

    // Direct door: refused, and the failure is 'unavailable' (a shape defect),
    // NOT 'integrity' (a proven forgery).
    await expect(fetchItemById(GENESIS, PUBLICATION_MODULE, undefined, GATEWAY)).rejects.toThrow(
      /unavailable: malformed content item/,
    );

    // Collection door: the same item becomes a skip with the SAME cause —
    // 'unavailable' (shape), never 'integrity' (proven forgery) — and is never
    // handed to the caller as a body.
    vi.mocked(evmRead).mockResolvedValue([
      { genesis: GENESIS, author: '0xauthor', cid: CID, timestamp: 1700000000 },
    ] as never);
    const { bodies, skips } = await fetchByPublicationWithSkips(PUBLICATION_MODULE, [], GATEWAY);

    expect(bodies).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0].genesis).toBe(GENESIS);
    expect(skips[0].cause).toBe('unavailable');
    expect(skips[0].reason).toMatch(/^unavailable: malformed content item/);
  });
});

describe('collection readers — the same choke point (C1)', () => {
  const GOOD_GENESIS = '0x' + '22'.repeat(32);
  const FORGED_GENESIS = '0x' + '33'.repeat(32);
  const GONE_GENESIS = '0x' + '44'.repeat(32);
  const GOOD_CID = 'bafygood';
  const FORGED_CID = 'bafyforged';
  const GONE_CID = 'bafygone';

  const deal = (genesis: string, cid: string): Entry => ({
    genesis,
    author: '0xauthor',
    cid,
    timestamp: 1700000000,
  });

  beforeEach(() => {
    vi.mocked(evmRead).mockResolvedValue([
      deal(GOOD_GENESIS, GOOD_CID),
      deal(FORGED_GENESIS, FORGED_CID),
      deal(GONE_GENESIS, GONE_CID),
    ] as never);
    vi.mocked(catFile).mockImplementation(((gateway: string, cid: string) => {
      if (cid === GOOD_CID) return Promise.resolve(JSON.stringify(mkItem()));
      if (cid === FORGED_CID) {
        return Promise.resolve(
          JSON.stringify(mkItem({ body: JSON.stringify({ content: 'FORGED' }) })),
        );
      }
      return Promise.reject(new Error('gateway 504'));
    }) as never);
  });

  it('never returns a forged body: it becomes a skip with cause integrity', async () => {
    const { bodies, skips } = await fetchByPublicationWithSkips(PUBLICATION_MODULE, [], GATEWAY);

    expect(bodies.map((b) => b.content)).toEqual(['Hello']); // deal order, forged one absent
    expect(skips).toHaveLength(2);

    const forged = skips.find((s) => s.cid === FORGED_CID);
    expect(forged?.genesis).toBe(FORGED_GENESIS);
    expect(forged?.cause).toBe('integrity');
    expect(forged?.reason).toContain('hash-mismatch');
    expect(forged?.reason).toContain(FORGED_CID);

    const gone = skips.find((s) => s.cid === GONE_CID);
    expect(gone?.cause).toBe('unavailable');
    expect(gone?.reason).toContain('IPFS retrieval failed');
  });

  it('applies the same rule to fetchByPublicationDetailed (bootstrap path)', async () => {
    const { bodies, items, entries, skips } = await fetchByPublicationDetailed(
      PUBLICATION_MODULE,
      [],
      GATEWAY,
    );

    expect(entries).toHaveLength(3);
    expect(bodies.map((b) => b.content)).toEqual(['Hello']);
    // the archive seed must never receive a forged item either
    expect([...items.keys()]).toEqual([GOOD_GENESIS]);
    expect(skips.map((s) => s.cause).sort()).toEqual(['integrity', 'unavailable']);
  });

  it('keeps legacy items (no plaintextHash) — verified by design is opt-in', async () => {
    vi.mocked(catFile).mockResolvedValue(JSON.stringify(legacyItem()));

    const { bodies, skips } = await fetchByPublicationWithSkips(PUBLICATION_MODULE, [], GATEWAY);

    expect(skips).toEqual([]);
    expect(bodies).toHaveLength(3);
  });
});
