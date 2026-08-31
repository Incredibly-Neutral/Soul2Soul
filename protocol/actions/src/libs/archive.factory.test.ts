import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_FORMAT,
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

/** A schema-valid canonical content item (plain by default; encrypted on demand). */
const mkItem = (genesis: string, opts?: { encryption?: boolean }): S2SContentItem => ({
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
    plaintextHash: '0x' + '0'.repeat(64),
  },
  objectId: '0x' + '1'.repeat(64),
  proof: {
    type: 'eip712',
    signer: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    signature: ('0x' + '2'.repeat(130)) as `0x${string}`,
  },
  encryption: opts?.encryption ?? false,
  body: opts?.encryption
    ? `ciphertext-${genesis}`
    : JSON.stringify({
        title: `title-${genesis}`,
        slug: `slug-${genesis}`,
        content: `content-${genesis}`,
      }),
});

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
// Cache bootstrap: seeding the FIRST archive snapshot (write-back with
// archiveCid === '').
//
// When the content_cache_ pointer is empty (dead-on-arrival), the write-back
// treats the current archive as null. reconcile(deals, null) nulls EVERY deal
// to needsFetch (the intended seed semantics), the write-back pulls the full
// freshly-fetched items into `refreshed`, and mergeArchive(null, deals,
// refreshed) seeds the first snapshot. This must serialize to a buffer that
// parseArchive round-trips with the expected genesis → {cid, item} entries,
// each item validating against the shared content-item schema.
// ============================================================================

describe("cache bootstrap: seed first archive snapshot (write-back with archiveCid === '')", () => {
  it('seeds a valid archive from mergeArchive(null, deals, refreshed) that round-trips and validates', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2'), mkEntry('g3', 'cid3')];

    // The no-archive read path observes a FULL all-deals needsFetch drift
    // (reconcile against a null archive nulls every deal).
    const { fresh, needsFetch } = reconcile(deals, null);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1', 'g2', 'g3']);

    // The write-back pulls the FULL freshly-fetched items for those needsFetch
    // entries (the bootstrap drift's fetchedItems) into `refreshed`.
    const refreshed = new Map<string, S2SContentItem>([
      ['g1', mkItem('g1')],
      ['g2', mkItem('g2', { encryption: true })],
    ]);
    // g3 is dealt but not fetched/refreshed → must NOT appear (deal-set floor /
    // lazy convergence; the N1 guard in the write-back also skips an empty
    // refresh).

    // Seed the first snapshot from a null previous archive.
    const next = mergeArchive(null, deals, refreshed);

    // Serialized archive parses back cleanly with the expected genesis entries.
    const serialized = serialize(next);
    const parsed = parseArchive(serialized);
    expect(parsed.format).toBe(ARCHIVE_FORMAT);
    expect(parsed.items.g1).toEqual({ cid: 'cid1', item: mkItem('g1') });
    expect(parsed.items.g2).toEqual({ cid: 'cid2', item: mkItem('g2', { encryption: true }) });
    expect(parsed.items.g3).toBeUndefined();

    // Every stored item validates against the shared content-item schema.
    expect(Object.keys(parsed.items).length).toBe(2);
    for (const entry of Object.values(parsed.items)) {
      expect(s2sContentItemSchema.safeParse(entry.item).success).toBe(true);
    }
  });
});
