import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  ARCHIVE_FORMAT,
  checkItemBodyIntegrity,
  parseArchive,
  reconcile,
  mergeArchive,
  serialize,
  type Archive,
} from './archive.factory';
import type { Entry } from './module.factory';
import { toBody } from './module.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared/rendering/action-io';

// ============================================================================
// archive.factory — per-publication IPFS content archive (pure, deterministic).
//
// Correctness home of the archive: classify fresh/miss/stale against the
// freshness oracle (getDeals), merge refreshed items back in, and never throw
// on a corrupt/cached blob (fail open to an empty archive).
//
// Each stored entry carries the FULL canonical content item (S2SContentItem),
// validated against the existing shared content-item schema; reconcile()'s
// OUTPUT stays the flat toBody bodies for the filter/sort chain.
// ============================================================================

const mkEntry = (genesis: string, cid: string): Entry => ({
  genesis,
  author: '0xauthor',
  cid,
  timestamp: 1234,
});

/** Honest plaintext body for a genesis (the bytes plaintextHash is taken over). */
const plainBody = (genesis: string): string =>
  JSON.stringify({
    title: `title-${genesis}`,
    slug: `slug-${genesis}`,
    content: `content-${genesis}`,
  });

const hashOf = (body: string): string => keccak256(toUtf8Bytes(body));

interface ItemOpts {
  encryption?: boolean;
  /** Override the body (defaults to the honest plaintext / ciphertext body). */
  body?: string;
  /** Override public.plaintextHash; `null` omits it entirely (legacy item). */
  plaintextHash?: string | null;
}

/** A schema-valid canonical content item (plain by default; encrypted on demand). */
const mkItem = (genesis: string, opts?: ItemOpts): S2SContentItem => {
  const encryption = opts?.encryption ?? false;
  const body = opts?.body ?? (encryption ? `ciphertext-${genesis}` : plainBody(genesis));
  // Honest default: the hash of the body it carries. Encrypted items carry a
  // ciphertext body, so their plaintextHash is (correctly) unrelated to it.
  const plaintextHash =
    opts?.plaintextHash === null
      ? undefined
      : (opts?.plaintextHash ?? (encryption ? '0x' + '0'.repeat(64) : hashOf(body)));

  return {
    public: {
      specVersion: '1',
      author: ('did:ethr:0x' + 'a'.repeat(40)) as `did:ethr:0x${string}`,
      postType: 'post',
      mediaType: 'text/markdown',
      parent: '',
      position: '0',
      publication: 'pub',
      locale: 'en',
      createdAt: 1234,
      base: '',
      tags: [],
      attributes: {},
      ...(plaintextHash === undefined ? {} : { plaintextHash }),
    },
    objectId: '0x' + '1'.repeat(64),
    proof: {
      type: 'eip712',
      signer: ('0x' + 'b'.repeat(40)) as `0x${string}`,
      signature: ('0x' + '2'.repeat(130)) as `0x${string}`,
    },
    encryption,
    body,
  } as unknown as S2SContentItem;
};

const mkArchive = (items: Record<string, any>): Archive => ({
  format: ARCHIVE_FORMAT,
  publication: 'pub',
  built: '2026-01-01T00:00:00.000Z',
  items,
});

describe('parseArchive', () => {
  it('returns an empty archive (no throw) for malformed JSON', () => {
    const a = parseArchive('{not json');
    expect(a.format).toBe(ARCHIVE_FORMAT);
    expect(a.items).toEqual({});
  });

  it('returns an empty archive for valid JSON with a wrong shape', () => {
    expect(parseArchive('"just a string"').items).toEqual({});
    expect(parseArchive('{"format":"other/1","items":{}}').items).toEqual({});
    expect(parseArchive('{"format":"s2s-publication-archive/2","items":[]}').items).toEqual({});
    expect(
      parseArchive('{"format":"s2s-publication-archive/2","publication":42,"items":{}}').items,
    ).toEqual({});
  });

  it('round-trips a valid archive through serialize', () => {
    const a = mkArchive({ g1: { cid: 'cid1', item: mkItem('g1') } });
    expect(parseArchive(serialize(a))).toEqual(a);
  });

  it('drops malformed items but keeps well-formed ones', () => {
    const json = JSON.stringify({
      format: ARCHIVE_FORMAT,
      publication: 'pub',
      built: '2026-01-01T00:00:00.000Z',
      items: {
        g1: { cid: 'cid1', item: mkItem('g1') }, // well-formed → kept
        g2: { item: mkItem('g2') }, // missing cid → dropped
        g3: { cid: 'cid3' }, // missing item → dropped
        g4: 'not-an-object', // wrong shape → dropped
      },
    });
    const parsed = parseArchive(json);
    expect(parsed.items.g1).toEqual({ cid: 'cid1', item: mkItem('g1') });
    expect(parsed.items.g2).toBeUndefined();
    expect(parsed.items.g3).toBeUndefined();
    expect(parsed.items.g4).toBeUndefined();
  });

  it('validates each item against the existing content-item schema (schema-invalid → dropped)', () => {
    const badAuthor = { ...mkItem('g1'), public: { ...mkItem('g1').public, author: 'not-a-did' } };
    const badEncryption = { ...mkItem('g2'), encryption: 'yes' as unknown as boolean };
    const missingProof = { ...mkItem('g3'), proof: undefined };
    const json = JSON.stringify({
      format: ARCHIVE_FORMAT,
      publication: 'pub',
      built: '2026-01-01T00:00:00.000Z',
      items: {
        g1: { cid: 'cid1', item: badAuthor }, // author fails did:ethr regex → dropped
        g2: { cid: 'cid2', item: badEncryption }, // encryption not boolean → dropped
        g3: { cid: 'cid3', item: missingProof }, // proof missing → dropped
        g4: { cid: 'cid4', item: mkItem('g4') }, // valid → kept
      },
    });
    const parsed = parseArchive(json);
    expect(parsed.items.g1).toBeUndefined();
    expect(parsed.items.g2).toBeUndefined();
    expect(parsed.items.g3).toBeUndefined();
    expect(parsed.items.g4).toEqual({ cid: 'cid4', item: mkItem('g4') });
  });

  it('old-format (v1) archives parse to empty — full refetch after the format bump', () => {
    const json = JSON.stringify({
      format: 's2s-publication-archive/1',
      publication: 'pub',
      built: '2026-01-01T00:00:00.000Z',
      items: { g1: { cid: 'cid1', item: mkItem('g1') } },
    });
    const parsed = parseArchive(json);
    expect(parsed.format).toBe(ARCHIVE_FORMAT);
    expect(parsed.items).toEqual({});
  });
});

describe('reconcile', () => {
  it('classifies fresh / miss / stale correctly (incl. cid-mismatch stale)', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2'), mkEntry('g3', 'cid3')];
    const archive = mkArchive({
      g1: { cid: 'cid1', item: mkItem('g1') }, // fresh: cid matches
      g2: { cid: 'cid2-old', item: mkItem('g2-old') }, // stale: cid differs
      // g3 absent → miss
    });
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect([...fresh.keys()]).toEqual(['g1']);
    expect(fresh.get('g1')).toEqual(toBody(mkEntry('g1', 'cid1'), mkItem('g1')));
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g2', 'g3']);
  });

  it('serves flat toBody output for fresh entries (plain + encrypted)', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const archive = mkArchive({
      g1: { cid: 'cid1', item: mkItem('g1') },
      g2: { cid: 'cid2', item: mkItem('g2', { encryption: true }) },
    });
    const { fresh } = reconcile(deals, archive);

    // plain: flat body carries the parsed title/slug/content + public metadata
    const plain = fresh.get('g1');
    expect(plain).toEqual(toBody(mkEntry('g1', 'cid1'), mkItem('g1')));
    expect(plain.encryption).toBe(false);
    expect(plain.id).toBe('g1');
    expect(plain.title).toBe('title-g1');
    expect(plain.slug).toBe('slug-g1');
    expect(plain.content).toBe('content-g1');
    expect(plain.author).toBe('did:ethr:0x' + 'a'.repeat(40));
    expect(plain.postType).toBe('post');
    expect(plain.publication).toBe('pub');

    // encrypted: body carries the ciphertext, never decrypted plaintext
    const enc = fresh.get('g2');
    expect(enc).toEqual(toBody(mkEntry('g2', 'cid2'), mkItem('g2', { encryption: true })));
    expect(enc.encryption).toBe(true);
    expect(enc.content).toBe('ciphertext-g2');
    expect(enc.title).toBeUndefined();
  });

  it('bias-toward-inclusion: malformed entry (missing cid or item) ⇒ MISS, not drop', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const archive = mkArchive({
      g1: { cid: 'cid1' }, // missing item
      g2: { item: mkItem('g2') }, // missing cid
    });
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1', 'g2']);
  });

  it('bias-toward-inclusion: schema-invalid item in a hand-built archive ⇒ MISS', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const badAuthor = { ...mkItem('g1'), public: { ...mkItem('g1').public, author: 'nope' } };
    const archive = mkArchive({ g1: { cid: 'cid1', item: badAuthor } });
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
  });

  it('does not throw on a schema-valid plain item with non-JSON body (MISS, refetch)', () => {
    const deals = [mkEntry('g1', 'cid1')];
    // body is schema-valid (s2sContentItemSchema only requires z.string()) but
    // not parseable JSON → toBody would throw; reconcile must treat it as MISS
    // (fail-open preserved, bias toward inclusion unchanged).
    const badBody = { ...mkItem('g1'), body: 'not-json' };
    const archive = mkArchive({ g1: { cid: 'cid1', item: badBody } });
    expect(() => reconcile(deals, archive)).not.toThrow();
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
  });

  it('archive-absent (null) ⇒ all deals are MISS, nothing to drop', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const { fresh, needsFetch } = reconcile(deals, null);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1', 'g2']);
  });

  it('empty deals ⇒ no fresh entries, no fetches', () => {
    const { fresh, needsFetch } = reconcile([], null);
    expect(fresh.size).toBe(0);
    expect(needsFetch).toEqual([]);
  });
});

describe('archive read-path integrity (plaintextHash check)', () => {
  it('serves an honest archive item (body hashes to its own plaintextHash)', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const item = mkItem('g1');
    expect(checkItemBodyIntegrity(item)).toBe('verified');
    const { fresh, needsFetch, integrityFailures } = reconcile(
      deals,
      mkArchive({ g1: { cid: 'cid1', item } }),
    );
    expect(fresh.get('g1')).toEqual(toBody(deals[0], item));
    expect(needsFetch).toEqual([]);
    expect(integrityFailures).toEqual([]);
  });

  it('FORGED item (real deal cid, fake body, another body’s honest hash) is NOT served — refetched', () => {
    const deal = mkEntry('g1', 'cid1');
    // The attacker writes the cache pointer with a schema-valid item claiming
    // the real deal cid, carrying a fake body while reusing the plaintextHash
    // of a genuinely authored body (so the item LOOKS honest).
    const forged: S2SContentItem = {
      ...mkItem('g1'),
      body: JSON.stringify({ title: 'pwned', slug: 'pwned', content: '<script>x</script>' }),
      public: { ...mkItem('g1').public, plaintextHash: mkItem('other').public.plaintextHash },
    };
    expect(checkItemBodyIntegrity(forged)).toBe('mismatch');

    const { fresh, needsFetch, integrityFailures } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item: forged } }),
    );
    // never served …
    expect(fresh.size).toBe(0);
    expect(fresh.has('g1')).toBe(false);
    // … and classified MISS so the caller refetches from the on-chain cid,
    // with the tamper evidence surfaced.
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
    expect(needsFetch[0].cid).toBe('cid1');
    expect(integrityFailures.map((e) => e.genesis)).toEqual(['g1']);
  });

  it('does NOT reject an encrypted archive item (ciphertext body — checked post-decrypt)', () => {
    const deals = [mkEntry('g1', 'cid1')];
    // plaintextHash is unrelated to the ciphertext body by construction.
    const item = mkItem('g1', { encryption: true });
    expect(checkItemBodyIntegrity(item)).toBe('unverifiable');
    const { fresh, needsFetch, integrityFailures } = reconcile(
      deals,
      mkArchive({ g1: { cid: 'cid1', item } }),
    );
    expect(fresh.get('g1')).toEqual(toBody(deals[0], item));
    expect(needsFetch).toEqual([]);
    expect(integrityFailures).toEqual([]);
  });

  it('serves a LEGACY item without plaintextHash (unverifiable, not invalid)', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const legacy = mkItem('g1', { plaintextHash: null });
    expect(checkItemBodyIntegrity(legacy)).toBe('unverifiable');

    // reconcile serves it straight from a hand-built archive …
    const { fresh, needsFetch, integrityFailures } = reconcile(
      deals,
      mkArchive({ g1: { cid: 'cid1', item: legacy } }),
    );
    expect(fresh.get('g1')).toEqual(toBody(deals[0], legacy));
    expect(needsFetch).toEqual([]);
    expect(integrityFailures).toEqual([]);

    // … and parseArchive does not drop it (the shared schema requires the
    // field; legacy absence is tolerated as unverifiable).
    const parsed = parseArchive(serialize(mkArchive({ g1: { cid: 'cid1', item: legacy } })));
    expect(parsed.items.g1.item).toEqual(legacy);
    expect(parsed.items.g1.item.public.plaintextHash).toBeUndefined();
  });

  it('still rejects a legacy-SHAPED item that is malformed for another reason', () => {
    const broken = {
      ...mkItem('g1', { plaintextHash: null }),
      public: { ...mkItem('g1').public, author: 'not-a-did' },
    } as unknown as S2SContentItem;
    const { fresh, needsFetch } = reconcile(
      [mkEntry('g1', 'cid1')],
      mkArchive({ g1: { cid: 'cid1', item: broken } }),
    );
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
  });
});

describe('mergeArchive', () => {
  it('drops no-deal entries, keeps untouched fresh entries, replaces refreshed ones', () => {
    const prev = mkArchive({
      g1: { cid: 'cid1', item: mkItem('g1') }, // dealt, not refreshed → kept as-is
      g2: { cid: 'cid2-old', item: mkItem('g2-old') }, // refreshed → replaced
      g3: { cid: 'cid3', item: mkItem('g3') }, // no deal → dropped
    });
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2-new'), mkEntry('g4', 'cid4')];
    const refreshed = new Map<string, S2SContentItem>([
      ['g2', mkItem('g2-new')],
      ['g4', mkItem('g4')],
    ]);
    const merged = mergeArchive(prev, deals, refreshed);
    expect(merged.format).toBe(ARCHIVE_FORMAT);
    expect(merged.publication).toBe('pub');
    expect(merged.items.g1).toEqual({ cid: 'cid1', item: mkItem('g1') });
    expect(merged.items.g2).toEqual({ cid: 'cid2-new', item: mkItem('g2-new') });
    expect(merged.items.g3).toBeUndefined();
    expect(merged.items.g4).toEqual({ cid: 'cid4', item: mkItem('g4') });
    expect(merged.built).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('starts from an empty archive when prev is null', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const refreshed = new Map<string, S2SContentItem>([['g1', mkItem('g1')]]);
    const merged = mergeArchive(null, deals, refreshed);
    expect(merged.items).toEqual({ g1: { cid: 'cid1', item: mkItem('g1') } });
    expect(merged.publication).toBe('');
  });

  it('deal-but-not-refreshed genesis stays as-is (absent if never present)', () => {
    const prev = mkArchive({ g1: { cid: 'cid1', item: mkItem('g1') } });
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')]; // g2 dealt but not refreshed
    const merged = mergeArchive(prev, deals, new Map());
    expect(merged.items.g1).toEqual({ cid: 'cid1', item: mkItem('g1') });
    expect(merged.items.g2).toBeUndefined();
  });
});

// ============================================================================
// BOOTSTRAP WRITE-BACK SEED (cache-unbootstrap fix).
//
// When the per-publication archive pointer is empty (content_cache_ never
// written), the write-back must SEED the first snapshot from a null archive:
//   mergeArchive(null, deals, refreshed) → serialize → parseArchive round-trip.
// This mirrors what render/main.ts writeBackArchiveCache does for archiveCid=''.
// ============================================================================

describe('bootstrap write-back seed (archiveCid === "")', () => {
  it('seeds a parseable, schema-valid archive from mergeArchive(null, deals, refreshed)', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const refreshed = new Map<string, S2SContentItem>([
      ['g1', mkItem('g1')],
      ['g2', mkItem('g2', { encryption: true })],
    ]);

    // reconcile(deals, null) — the null-archive seed contract — classifies
    // EVERY deal as a MISS, so the bootstrap drift's needsFetch === all deals.
    const { fresh, needsFetch } = reconcile(deals, null);
    expect(fresh.size).toBe(0);
    expect(needsFetch).toEqual(deals);

    // Seed the first snapshot exactly as the write-back does for archiveCid=''.
    const next = mergeArchive(null, deals, refreshed);
    const parsed = parseArchive(serialize(next));

    // Round-trips through serialize/parseArchive as a valid archive.
    expect(parsed.format).toBe(ARCHIVE_FORMAT);
    expect(parsed.items.g1).toEqual({ cid: 'cid1', item: mkItem('g1') });
    expect(parsed.items.g2).toEqual({ cid: 'cid2', item: mkItem('g2', { encryption: true }) });

    // Each stored item still validates against the shared content-item schema.
    for (const item of [parsed.items.g1.item, parsed.items.g2.item]) {
      expect(s2sContentItemSchema.safeParse(item).success).toBe(true);
    }
  });
});
