import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';
import {
  ARCHIVE_FORMAT,
  addressOf,
  checkItemBodyIntegrity,
  inspectItemIntegrity,
  isValidContentItem,
  judgeRefetchedItem,
  parseArchive,
  reconcile,
  mergeArchive,
  serialize,
  type Archive,
} from './archive.factory';
import type { Entry } from './module.factory';
import { toBody } from './module.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { jcs } from '@s2s/soul2soul-shared/lit-actions';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared/rendering/action-io';
// The mint and the signing view come from shared (out of scope for edits, so
// deep-imported exactly like the module under test deep-imports them).
import { buildSigningView } from '../../../../shared/dist/identity/signing-view';
import { S2S_DOMAIN, S2S_TYPES, toDidEthr } from '../../../../shared/dist/protocol/types';

// ============================================================================
// archive.factory — per-publication IPFS content archive (pure, deterministic).
//
// Correctness home of the archive: classify fresh/miss/stale against the
// freshness oracle (getDeals), merge refreshed items back in, never throw on a
// corrupt/cached blob (fail open to an empty archive), and NEVER serve an item
// that fails the integrity verdict.
//
// Fixtures are MINTED, not hand-shaped: plaintextHash/objectId/proof.signature
// are produced the way the real mint produces them (JCS body → keccak256 →
// EIP-712 digest → real signature), so the tests exercise the same bytes a
// publication actually stores. An item built with JSON.stringify would not.
// ============================================================================

// The ambient ethers v5 global a Lit Action provides (`ethers.utils`). It is
// absent under vitest, so the signature checks would downgrade to
// 'signature-unrecoverable'; stub the two functions the verdict uses, backed by
// ethers v6 (identical EIP-712/ecrecover semantics).
beforeAll(() => {
  vi.stubGlobal('ethers', {
    utils: {
      _TypedDataEncoder: { hash: TypedDataEncoder.hash },
      recoverAddress,
    },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const AUTHOR = new Wallet('0x' + '11'.repeat(32));
const ATTACKER = new Wallet('0x' + '22'.repeat(32));

const mkEntry = (genesis: string, cid: string, author: string = AUTHOR.address): Entry => ({
  genesis,
  author, // getDeals() returns a plain address, NOT a did:ethr
  cid,
  timestamp: 1234,
});

const bodyOf = (genesis: string) => ({
  title: `title-${genesis}`,
  slug: `slug-${genesis}`,
  content: `content-${genesis}`,
});

/** Honest plaintext body bytes for a genesis (what plaintextHash is taken over). */
const plainBody = (genesis: string): string => jcs(bodyOf(genesis));

const hashOf = (body: string): string => keccak256(toUtf8Bytes(body));

interface ItemOpts {
  encryption?: boolean;
  /** Mint with a different signing key (still records ITS address as author by default). */
  signer?: Wallet;
  /** Author identity in `public` (defaults to the signer's). */
  author?: string;
  /** Body object to mint (defaults to the honest body for the genesis). */
  bodyObject?: Record<string, unknown>;
  /** Override the STORED body string (the forged-body lever). */
  body?: string;
  /** Override public.plaintextHash; `null` omits it entirely (legacy item). */
  plaintextHash?: string | null;
  /** Omit specVersion too (true legacy item: pre-EIP-712 shape). */
  legacy?: boolean;
  /** Corrupt objectId after minting. */
  objectId?: string;
  /** Omit the proof entirely. */
  noProof?: boolean;
  /** Override proof.signer after minting. */
  proofSigner?: string;
}

/**
 * Mint a genuine content item: JCS body → plaintextHash → EIP-712 digest
 * (= objectId) → real signature over the signing view. Everything is produced
 * the way buildSignedContentItem produces it, so 'verified' means "the real
 * mint verifies", not "the fixture was shaped to pass".
 *
 * Tampering levers (plaintextHash/legacy/objectId/proof/body) are applied
 * AFTER minting, exactly like an attacker rewriting the stored blob — a public
 * block with a non-bytes32 hash could not have been signed at all.
 */
const mkItem = (genesis: string, opts?: ItemOpts): S2SContentItem => {
  const signer = opts?.signer ?? AUTHOR;
  const encryption = opts?.encryption ?? false;
  const bodyObj = opts?.bodyObject ?? bodyOf(genesis);
  const bodyJson = jcs(bodyObj);
  const plaintextHash = hashOf(bodyJson);

  const pub: Record<string, unknown> = {
    specVersion: '1',
    author: opts?.author ?? toDidEthr(signer.address),
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
    plaintextHash,
  };

  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as any,
    S2S_TYPES as any,
    buildSigningView(pub as any),
  );
  const signature = signer.signingKey.sign(digest).serialized;

  const item: Record<string, any> = {
    public: pub,
    objectId: digest,
    proof: {
      type: 'eip712' as const,
      signer: signer.address,
      signature,
    },
    encryption,
    // Encrypted items store ciphertext (the plaintextHash covers the plaintext).
    body: encryption ? `ciphertext-${genesis}` : bodyJson,
  };

  // ── tampering levers ──
  if (opts?.plaintextHash === null) delete item.public.plaintextHash;
  else if (opts?.plaintextHash !== undefined) item.public.plaintextHash = opts.plaintextHash;
  if (opts?.legacy) {
    delete item.public.specVersion;
    delete item.public.plaintextHash;
  }
  if (opts?.objectId !== undefined) item.objectId = opts.objectId;
  if (opts?.noProof) delete item.proof;
  else if (opts?.proofSigner !== undefined) item.proof.signer = opts.proofSigner;
  if (opts?.body !== undefined) item.body = opts.body;

  return item as unknown as S2SContentItem;
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
    expect(plain.author).toBe(toDidEthr(AUTHOR.address));
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

describe('archive integrity verdict (bound to the on-chain deal author)', () => {
  it('serves an honest, minted archive item (verified, no issues, no fetch)', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1');
    expect(inspectItemIntegrity(item, deal.author)).toEqual({
      level: 'verified',
      code: 'verified',
      reason: '',
    });
    const { fresh, needsFetch, integrityIssues } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item } }),
    );
    expect(fresh.get('g1')).toEqual(toBody(deal, item));
    expect(needsFetch).toEqual([]);
    expect(integrityIssues).toEqual([]);
  });

  it('REFUSES a whole-item forgery: attacker’s own public block (author, hash, proof) at a real deal cid', () => {
    // The attack the previous round could not catch: every check inside the
    // blob is self-consistent — attacker's author, attacker's plaintextHash,
    // attacker's valid signature, correct objectId. Only the on-chain deal
    // author can refute it.
    const deal = mkEntry('g1', 'cid1');
    const forged = mkItem('g1', {
      signer: ATTACKER,
      bodyObject: { title: 'pwned', slug: 'pwned', content: '<script>x</script>' },
    });
    // self-consistent in isolation …
    expect(forged.public.plaintextHash).toBe(hashOf(forged.body));
    // … but not authored by the deal's author
    expect(inspectItemIntegrity(forged, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'author-mismatch',
    });
    // (and it IS what the old, author-blind check called 'verified')
    expect(checkItemBodyIntegrity(forged)).toBe('verified');

    const { fresh, needsFetch, integrityIssues } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item: forged } }),
    );
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
    expect(integrityIssues.map((i) => [i.genesis, i.code])).toEqual([['g1', 'author-mismatch']]);
  });

  it('REFUSES a forged body that reuses an honest item’s plaintextHash', () => {
    const deal = mkEntry('g1', 'cid1');
    const honest = mkItem('other');
    const forged = mkItem('g1', {
      body: jcs({ title: 'pwned', slug: 'pwned', content: 'pwned' }),
      plaintextHash: honest.public.plaintextHash,
    });
    expect(inspectItemIntegrity(forged, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'hash-mismatch',
    });
    const { fresh, integrityIssues } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item: forged } }),
    );
    expect(fresh.size).toBe(0);
    expect(integrityIssues.map((i) => i.code)).toEqual(['hash-mismatch']);
  });

  it('REFUSES an item whose public.author is not the deal author (did:ethr vs plain address normalised)', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { author: toDidEthr(ATTACKER.address) });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'author-mismatch',
    });
    // sanity: did:ethr and plain forms normalise to the same address
    expect(addressOf(toDidEthr(AUTHOR.address))).toBe(addressOf(AUTHOR.address));
    expect(addressOf('did:ethr:0Xnothex')).toBeNull();
  });

  it('REFUSES a stripped hash on a specVersion item (the field cannot be deleted to opt out)', () => {
    const deal = mkEntry('g1', 'cid1');
    const stripped = mkItem('g1', { plaintextHash: null });
    expect(stripped.public.specVersion).toBe('1');
    expect(inspectItemIntegrity(stripped, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'hash-missing',
    });
    const { fresh, needsFetch } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item: stripped } }),
    );
    expect(fresh.size).toBe(0);
    expect(needsFetch.map((e) => e.genesis)).toEqual(['g1']);
  });

  it('does NOT lose content permanently on a MALFORMED hash: unverifiable + served, no refetch', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { plaintextHash: '0xzz' });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'unverifiable',
      code: 'hash-malformed',
    });
    const { fresh, needsFetch, integrityIssues } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item } }),
    );
    // served …
    expect(fresh.get('g1')).toEqual(toBody(deal, item));
    // … and NOT pushed into a refetch loop that can never converge (the
    // refetched item carries the same bad hash) and never reported as tampering.
    expect(needsFetch).toEqual([]);
    expect(integrityIssues).toEqual([]);
  });

  it('serves a LEGACY item (no specVersion, no plaintextHash) author-bound only', () => {
    const deal = mkEntry('g1', 'cid1');
    const legacy = mkItem('g1', { legacy: true });
    expect(legacy.public.specVersion).toBeUndefined();
    expect(inspectItemIntegrity(legacy, deal.author)).toMatchObject({
      level: 'unverifiable',
      code: 'legacy-item',
    });
    // a legacy item with the WRONG author is still refused
    const legacyWrongAuthor = mkItem('g2', { legacy: true, author: toDidEthr(ATTACKER.address) });
    expect(inspectItemIntegrity(legacyWrongAuthor, ATTACKER.address)).toMatchObject({
      level: 'unverifiable',
    });
    expect(inspectItemIntegrity(legacyWrongAuthor, mkEntry('g2', 'cid2').author)).toMatchObject({
      level: 'mismatch',
      code: 'author-mismatch',
    });

    const { fresh, needsFetch, integrityIssues } = reconcile(
      [deal],
      mkArchive({ g1: { cid: 'cid1', item: legacy } }),
    );
    expect(fresh.get('g1')).toEqual(toBody(deal, legacy));
    expect(needsFetch).toEqual([]);
    expect(integrityIssues).toEqual([]);

    // … and parseArchive does not drop it (the shared schema requires the
    // fields; legacy absence is tolerated as unverifiable).
    const parsed = parseArchive(serialize(mkArchive({ g1: { cid: 'cid1', item: legacy } })));
    expect(parsed.items.g1.item).toEqual(legacy);
    expect(parsed.items.g1.item.public.plaintextHash).toBeUndefined();
    expect(parsed.items.g1.item.public.specVersion).toBeUndefined();
  });

  it('does NOT hash-check an encrypted body, but still binds it to the author', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { encryption: true });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'unverifiable',
      code: 'encrypted',
    });
    const ok = reconcile([deal], mkArchive({ g1: { cid: 'cid1', item } }));
    expect(ok.fresh.get('g1')).toEqual(toBody(deal, item));
    expect(ok.needsFetch).toEqual([]);

    // Anyone can encrypt their own plaintext to the publication PKP, so the
    // author binding is the only check that runs here — and it must.
    const forged = mkItem('g1', { encryption: true, signer: ATTACKER });
    expect(inspectItemIntegrity(forged, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'author-mismatch',
    });
    expect(reconcile([deal], mkArchive({ g1: { cid: 'cid1', item: forged } })).fresh.size).toBe(0);
  });

  it('REFUSES an item whose objectId is not the EIP-712 digest of its public block', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { objectId: '0x' + '9'.repeat(64) });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'objectid-mismatch',
    });
  });

  it('REFUSES an item whose recovered signer contradicts proof.signer', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { proofSigner: ATTACKER.address });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'proof-signer-mismatch',
    });
  });

  it('REFUSES a specVersion item with no proof at all', () => {
    const deal = mkEntry('g1', 'cid1');
    const item = mkItem('g1', { noProof: true });
    expect(inspectItemIntegrity(item, deal.author)).toMatchObject({
      level: 'mismatch',
      code: 'proof-missing',
    });
  });

  it('RESIDUAL: a stolen author + attacker signature is served (unverifiable), never verified', () => {
    // Documented residual (see the module header): a Safe/contract-authored item
    // is signed by an owner EOA, so "recovered != author" cannot be treated as
    // fraud without an on-chain isOwner read. The verdict must say so instead of
    // claiming 'verified'; closing this needs the RPC follow-up.
    const deal = mkEntry('g1', 'cid1');
    const impersonation = mkItem('g1', {
      signer: ATTACKER,
      author: toDidEthr(AUTHOR.address),
      bodyObject: { title: 'pwned', slug: 'pwned', content: 'pwned' },
    });
    const verdict = inspectItemIntegrity(impersonation, deal.author);
    expect(verdict.level).toBe('unverifiable');
    expect(verdict.code).toBe('signature-not-author');
    expect(verdict.reason).toMatch(/contract-authored|author-bound only/);
  });

  it('without a typed-data signer in the runtime, hash + author binding still apply', () => {
    vi.unstubAllGlobals();
    try {
      const deal = mkEntry('g1', 'cid1');
      expect(inspectItemIntegrity(mkItem('g1'), deal.author)).toMatchObject({
        level: 'unverifiable',
        code: 'signature-unrecoverable',
      });
      // a body/hash mismatch is still refused without any signature machinery
      expect(
        inspectItemIntegrity(
          mkItem('g1', { body: jcs({ title: 'x', slug: 'x', content: 'x' }) }),
          deal.author,
        ),
      ).toMatchObject({ level: 'mismatch', code: 'hash-mismatch' });
    } finally {
      vi.stubGlobal('ethers', {
        utils: { _TypedDataEncoder: { hash: TypedDataEncoder.hash }, recoverAddress },
      });
    }
  });
});

describe('refetched-item policy (judgeRefetchedItem)', () => {
  it('is the one shared verdict: shape → author binding → hash → digest → proof', () => {
    const deal = mkEntry('g1', 'cid1');
    const honest = judgeRefetchedItem(mkItem('g1'), deal.author, 'g1', 'cid1');
    expect(honest.usable).toBe(true);
    expect(honest.integrity.level).toBe('verified');

    for (const bad of [null, [], 'a string', 42]) {
      const v = judgeRefetchedItem(bad, deal.author, 'g1', 'cid1');
      expect(v.usable).toBe(false);
      expect(v.integrity.code).toBe('malformed-item');
      expect(v.integrity.reason).toContain('not a valid content item');
    }

    const forged = judgeRefetchedItem(
      mkItem('g1', { signer: ATTACKER }),
      deal.author,
      'g1',
      'cid1',
    );
    expect(forged.usable).toBe(false);
    expect(forged.integrity.code).toBe('author-mismatch');
  });
});

describe('isValidContentItem (shape gate)', () => {
  it('accepts a minted item and tolerates a legacy item only when nothing else is wrong', () => {
    expect(isValidContentItem(mkItem('g1'))).toBe(true);
    expect(isValidContentItem(mkItem('g1', { legacy: true }))).toBe(true);
    expect(s2sContentItemSchema.safeParse(mkItem('g1', { legacy: true })).success).toBe(false);
    expect(isValidContentItem({ ...mkItem('g1', { legacy: true }), public: {} })).toBe(false);
    expect(isValidContentItem(null)).toBe(false);
  });

  it('still rejects a legacy-SHAPED item that is malformed for another reason', () => {
    const broken = {
      ...mkItem('g1', { legacy: true }),
      public: { ...(mkItem('g1', { legacy: true }).public as any), author: 'not-a-did' },
    } as unknown as S2SContentItem;
    expect(isValidContentItem(broken)).toBe(false);
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
