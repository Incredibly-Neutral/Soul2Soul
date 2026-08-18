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

// ============================================================================
// archive.factory — per-publication IPFS content archive (pure, deterministic).
//
// Correctness home of the archive: classify fresh/miss/stale against the
// freshness oracle (getDeals), merge refreshed bodies back in, and never throw
// on a corrupt/cached blob (fail open to an empty archive).
// ============================================================================

const mkEntry = (genesis: string, cid: string): Entry => ({
  genesis,
  author: '0xauthor',
  cid,
  timestamp: 1234,
});

const mkBody = (genesis: string) => ({
  id: genesis,
  title: `title-${genesis}`,
  content: `content-${genesis}`,
  encryption: false,
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
    expect(parseArchive('{"format":"s2s-publication-archive/1","items":[]}').items).toEqual({});
    expect(
      parseArchive('{"format":"s2s-publication-archive/1","publication":42,"items":{}}').items,
    ).toEqual({});
  });

  it('round-trips a valid archive through serialize', () => {
    const a = mkArchive({ g1: { cid: 'cid1', body: mkBody('g1') } });
    expect(parseArchive(serialize(a))).toEqual(a);
  });

  it('drops malformed items but keeps well-formed ones', () => {
    const json = JSON.stringify({
      format: ARCHIVE_FORMAT,
      publication: 'pub',
      built: '2026-01-01T00:00:00.000Z',
      items: {
        g1: { cid: 'cid1', body: mkBody('g1') }, // well-formed → kept
        g2: { body: mkBody('g2') }, // missing cid → dropped
        g3: { cid: 'cid3' }, // missing body → dropped
        g4: 'not-an-object', // wrong shape → dropped
      },
    });
    const parsed = parseArchive(json);
    expect(parsed.items.g1).toEqual({ cid: 'cid1', body: mkBody('g1') });
    expect(parsed.items.g2).toBeUndefined();
    expect(parsed.items.g3).toBeUndefined();
    expect(parsed.items.g4).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('classifies fresh / miss / stale correctly (incl. cid-mismatch stale)', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2'), mkEntry('g3', 'cid3')];
    const archive = mkArchive({
      g1: { cid: 'cid1', body: mkBody('g1') }, // fresh: cid matches
      g2: { cid: 'cid2-old', body: mkBody('g2-old') }, // stale: cid differs
      // g3 absent → miss
    });
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect([...fresh.keys()]).toEqual(['g1']);
    expect(fresh.get('g1')).toEqual(mkBody('g1'));
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g2', 'g3']);
  });

  it('bias-toward-inclusion: malformed entry (missing cid or body) ⇒ MISS, not drop', () => {
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')];
    const archive = mkArchive({
      g1: { cid: 'cid1' }, // missing body
      g2: { body: mkBody('g2') }, // missing cid
    });
    const { fresh, needsFetch } = reconcile(deals, archive);
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1', 'g2']);
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
      g1: { cid: 'cid1', body: mkBody('g1') }, // dealt, not refreshed → kept as-is
      g2: { cid: 'cid2-old', body: mkBody('g2-old') }, // refreshed → replaced
      g3: { cid: 'cid3', body: mkBody('g3') }, // no deal → dropped
    });
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2-new'), mkEntry('g4', 'cid4')];
    const refreshed = new Map<string, any>([
      ['g2', mkBody('g2-new')],
      ['g4', mkBody('g4')],
    ]);
    const merged = mergeArchive(prev, deals, refreshed);
    expect(merged.format).toBe(ARCHIVE_FORMAT);
    expect(merged.publication).toBe('pub');
    expect(merged.items.g1).toEqual({ cid: 'cid1', body: mkBody('g1') });
    expect(merged.items.g2).toEqual({ cid: 'cid2-new', body: mkBody('g2-new') });
    expect(merged.items.g3).toBeUndefined();
    expect(merged.items.g4).toEqual({ cid: 'cid4', body: mkBody('g4') });
    expect(merged.built).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('starts from an empty archive when prev is null', () => {
    const deals = [mkEntry('g1', 'cid1')];
    const refreshed = new Map([['g1', mkBody('g1')]]);
    const merged = mergeArchive(null, deals, refreshed);
    expect(merged.items).toEqual({ g1: { cid: 'cid1', body: mkBody('g1') } });
    expect(merged.publication).toBe('');
  });

  it('deal-but-not-refreshed genesis stays as-is (absent if never present)', () => {
    const prev = mkArchive({ g1: { cid: 'cid1', body: mkBody('g1') } });
    const deals = [mkEntry('g1', 'cid1'), mkEntry('g2', 'cid2')]; // g2 dealt but not refreshed
    const merged = mergeArchive(prev, deals, new Map());
    expect(merged.items.g1).toEqual({ cid: 'cid1', body: mkBody('g1') });
    expect(merged.items.g2).toBeUndefined();
  });
});
