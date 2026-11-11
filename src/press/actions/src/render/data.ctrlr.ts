import { decryptRaw, type DecryptedPlaintext } from '../libs/decrypt';
import {
  fetchByPublication,
  fetchByPublicationWithSkips,
  fetchByPublicationDetailed,
  getDeals,
  getLatestEntry,
  toBody,
  verifyDecryptedBody,
  type Entry,
  type ItemFailureKind,
} from '../libs/module.factory';
import { catFile } from '../libs/ipfs.factory';
import {
  parseArchive,
  reconcile,
  type Archive,
  type IntegrityIssue,
} from '../libs/archive.factory';
// The verdict itself lives in its own module now (shared with the direct read
// path); the archive module re-exports it, but consumers import the source.
import { inspectItemIntegrity, judgeRefetchedItem, skipReason } from '../libs/item-integrity';
import { jcs, verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';
import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';
import type { DataAvailabilityEntry } from '@s2s/soul2soul-shared/lit-actions';
import { transformContent } from './content-transforms';
import {
  S2SBodyEncrypted,
  S2SBodyPlain,
  S2SProof,
  type AnyS2SContentItem,
} from '../../../../shared/dist/manuscript/types';

export const createPath = (
  body: S2SBody,
  templateConfig: S2STemplateConfig,
  localePaths?: Record<string, string>,
): string => {
  if (templateConfig.path == null) return '/';
  const prefix = localePaths ? (localePaths[body.locale] ?? localePaths.default ?? '') : '';

  let path = prefix + templateConfig.path;

  if (!body.encryption && body.slug && path.includes('{slug}')) {
    path = path.replace('{slug}', body.slug);
  }

  return path;
};

/**
 * Identity fields that belong to the signed content item and must survive the
 * encrypted → decrypted transition: `plaintextHash` is the author-signed digest
 * of the body (what the post-decryption check compares against), and
 * `objectId`/`cid`/`specVersion`/`mediaType`/`proof` are what a verifier or the
 * render result needs to describe the item it actually rendered.
 *
 * Declared LOCALLY on purpose: `S2SBodyPlain`/`S2SBodyEncrypted` live in
 * shared/src/protocol/types.ts (out of scope) and widening them would churn
 * every consumer. `toBody()` will carry these fields once the direct-read
 * branch lands; until then they are simply absent and every copy is a no-op.
 */
export interface S2SBodyIdentity {
  cid?: string;
  objectId?: string;
  plaintextHash?: string;
  specVersion?: string;
  mediaType?: string;
  proof?: S2SProof;
}

export type S2SBodyPlainWithIdentity = S2SBodyPlain & S2SBodyIdentity;
export type S2SBodyEncryptedWithIdentity = S2SBodyEncrypted & S2SBodyIdentity;

/** Copy only the identity fields that are actually present (never fabricate). */
const copyIdentity = (body: S2SBodyIdentity): S2SBodyIdentity => {
  const out: S2SBodyIdentity = {};
  if (body.cid !== undefined) out.cid = body.cid;
  if (body.objectId !== undefined) out.objectId = body.objectId;
  if (body.plaintextHash !== undefined) out.plaintextHash = body.plaintextHash;
  if (body.specVersion !== undefined) out.specVersion = body.specVersion;
  if (body.mediaType !== undefined) out.mediaType = body.mediaType;
  if (body.proof !== undefined) out.proof = body.proof;
  return out;
};

export const mergeDecrypted = (
  body: S2SBodyEncryptedWithIdentity,
  decrypted: any,
): S2SBodyPlainWithIdentity => {
  return {
    id: body.id,
    author: body.author,
    locale: body.locale,
    parent: body.parent,
    position: body.position,
    postType: body.postType,
    creationDate: body.creationDate,
    modifiedDate: body.modifiedDate,
    tags: body.tags,
    attributes: body.attributes,
    publication: body.publication,
    ...copyIdentity(body),
    base: decrypted.base || undefined,
    encryption: false as const,
    content: decrypted.content,
    title: decrypted.title,
    slug: decrypted.slug,
    custom:
      typeof decrypted.custom === 'string'
        ? JSON.parse(decrypted.custom || '{}')
        : decrypted.custom || {},
  };
};

/**
 * Outcome of checking a decrypted body against the author-signed
 * `public.plaintextHash`.
 *
 *  - 'verified' — the decryptor handed back a STRING and it hashes to the
 *                 author's digest: byte equivalence with what was signed.
 *  - 'weak'     — the decryptor handed back a parsed object, so only its JCS
 *                 re-canonicalisation could be hashed. That proves SEMANTIC
 *                 equivalence of the parsed value (two identical parse trees
 *                 render identically), not byte equivalence — weaker as
 *                 evidence, still sufficient to render.
 *  - 'legacy'   — nothing was signed to compare against (no plaintextHash).
 *  - 'mismatch' — the bytes/values do NOT hash to the author's digest.
 */
export type DecryptedVerdict = 'verified' | 'weak' | 'legacy' | 'mismatch';

/**
 * Verify a DECRYPTED body against the author-signed plaintextHash.
 *
 * The raw branch delegates to `verifyDecryptedBody` (module.factory) — the SAME
 * function the collection path in render/main.ts calls — so the page body and a
 * collection item are always judged by identical byte semantics. Only the
 * weaker object branch lives here, for the case where the decryptor returns a
 * parsed value instead of the plaintext string (`rawFromDecryptor === false`).
 */
export const verifyDecrypted = (
  decrypted: Pick<DecryptedPlaintext, 'raw' | 'parsed' | 'rawFromDecryptor'>,
  expectedHash: string | null,
): DecryptedVerdict => {
  if (!expectedHash) return 'legacy';
  if (decrypted.rawFromDecryptor) {
    // One helper, one verdict: 'uncheckable' only happens when the item carries
    // no hash (already handled above), and 'weak' means the hash is present but
    // not a digest we can check — a doubt, exactly as at rest.
    const verdict = verifyDecryptedBody({ plaintextHash: expectedHash }, decrypted.raw);
    return verdict === 'uncheckable' ? 'legacy' : verdict;
  }
  try {
    // NOT JSON.stringify: JCS orders integer-like keys lexically, so
    // stringify(parsed) is neither what the author hashed nor canonical.
    return verifyBodyHash(jcs(decrypted.parsed), expectedHash) ? 'weak' : 'mismatch';
  } catch {
    return 'mismatch';
  }
};

/**
 * One-shot warning latch for the weak branch (the Lit Action module is
 * re-created per invocation, so this is per render, not per process).
 */
let warnedNonRawPlaintext = false;

/**
 * Resolve the author-signed `public.plaintextHash` for a body being rendered.
 *
 * Preferred source — and the only one taken on any normal render — is the flat
 * body itself: `toBody()` carries `plaintextHash`, so the hash is already in
 * hand and NO I/O happens. The re-read below is a fallback for a caller that
 * hands us a body without the identity fields (a hand-built or pre-identity
 * body): it pays one getLatestEntry + one cat, and integrity-binds the item to
 * its deal author before trusting the hash, exactly as the archive path does.
 * Returns null when the hash cannot be resolved (RPC/gateway failure, or an item
 * that genuinely has no hash): the caller must then say so instead of pretending
 * the body was verified.
 */
const resolvePlaintextHash = async (
  body: any,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<string | null> => {
  if (typeof body?.plaintextHash === 'string' && body.plaintextHash !== '') {
    return body.plaintextHash;
  }
  try {
    const entry = await getLatestEntry(body.id, publicationModule, rpcs);
    // PIN THE VERSION. The deal can advance mid-render, so `getLatestEntry` may
    // return a NEWER cid than the body being rendered; comparing this body's
    // plaintext against the next version's hash would fail a perfectly good
    // body (or, worse, "verify" it against a hash it was never signed under).
    // The body carries the cid it was read from (toBody), so refuse the
    // fallback unless the chain still points at exactly that version.
    const bodyCid = typeof body?.cid === 'string' ? body.cid : null;
    if (!bodyCid || bodyCid !== entry.cid) {
      console.warn(
        `post-decryption verification unavailable for ${String(body?.id)}: deal advanced past the rendered cid (${String(bodyCid)} -> ${entry.cid})`,
      );
      return null;
    }
    const item = JSON.parse(await catFile(gateway!, entry.cid));
    const verdict = inspectItemIntegrity(item, entry.author);
    if (verdict.level === 'mismatch') {
      throw new Error(`item failed integrity (${verdict.code}): ${verdict.reason}`);
    }
    const hash = item?.public?.plaintextHash;
    return typeof hash === 'string' && hash !== '' ? hash : null;
  } catch (e) {
    console.warn(
      `post-decryption verification unavailable for ${String(body?.id)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
};

export const pathsForCollections = (item: any, config: any) => {
  // console.log("item", item);
  // console.log("config", config)

  let _templateConfig: S2STemplateConfig | undefined = config.mapping.templateConfig.find(
    (m: any) => m.reference === item.postType,
  );

  return _templateConfig != undefined
    ? createPath(item, _templateConfig, config.localePaths)
    : undefined;
};

/**
 * PURE template-data builder for a NON-encrypted (plaintext) body.
 *
 * This is the shared core of the non-decrypt `initTemplateData` path: computes
 * the render path, unescapes the raw content, and applies the content-transform
 * stage. No chain, no decrypt, no fetch. Used by production `initTemplateData`
 * (when `body.encryption` is false) AND by the dev render action (which always
 * receives plaintext).
 */
export const buildTemplateData = (
  body: any,
  templateConfig: S2STemplateConfig,
  protocolInfo?: any,
  localePaths?: Record<string, string>,
) => {
  const path = createPath(body, templateConfig, localePaths);

  return {
    ...body,
    gateway: protocolInfo?.gateway,
    path,
    custom: body.custom || {},
    content: transformContent(
      (body.content || '').replace(/\\n/g, '\n').replace(/\\\"/g, '"').replace(/\\\\/g, '\\'),
    ),
    revoked: false,
  };
};

export const initTemplateData = async (
  protocolInfo: any,
  authorSafeAddress: string,
  signerAddress: string,
  templateConfig: S2STemplateConfig,
  body: S2SBody,
  publicationModule: string,
  rpcs?: string[],
  localePaths?: Record<string, string>,
) => {
  if (body.encryption) {
    const decrypted = await decryptRaw(
      protocolInfo.pkp,
      body,
      authorSafeAddress,
      publicationModule,
      signerAddress,
      rpcs,
    );
    if (!decrypted)
      return {
        ...body,
        path: createPath(body, templateConfig, localePaths),
        custom: {},
        content: '',
        revoked: true,
      };

    // ── Post-decryption integrity ──
    // Decryption proves nothing about authorship: anyone may encrypt to the
    // publication PKP (only DECRYPTION is gated by canRead), so an attacker can
    // ship their own plaintext under a real deal's identity. The encrypted body
    // could not be hash-checked at rest (it is ciphertext), so this is the one
    // place the plaintext exists: bind it to the author-signed plaintextHash
    // before it reaches the template.
    //
    // The page body is THE content, so a mismatch FAILS THE JOB (throw) — the
    // collection path in render/main.ts handles the same verdict non-fatally
    // (one item dropped, page still renders) because there the item is one of
    // many. Both hash with the SAME helper (verifyDecrypted → the raw branch
    // delegates to module.factory.verifyDecryptedBody), so the two paths cannot
    // drift apart on what "verified" means.
    const expectedHash = await resolvePlaintextHash(
      body,
      publicationModule,
      rpcs,
      protocolInfo?.gateway,
    );
    const verdict = verifyDecrypted(decrypted, expectedHash);
    if (verdict === 'mismatch') {
      throw new Error(
        `body integrity: decrypted content does not match public.plaintextHash for ${String(body.id)} (expected ${String(expectedHash)})`,
      );
    }
    if (verdict === 'legacy') {
      // Nothing signed to compare against (legacy item) or the hash could not
      // be resolved. Do not pretend: record it and continue unverified.
      console.warn(
        `body integrity: ${String(body.id)} could not be verified after decryption (no plaintextHash available)`,
      );
    }
    if (verdict === 'weak' && !warnedNonRawPlaintext) {
      // The decryptor returned a parsed object instead of the plaintext string.
      // Weaker evidence, but a decryptor CHANGE must not take every encrypted
      // page down — warn once and render, rather than throw.
      warnedNonRawPlaintext = true;
      console.warn(
        `body integrity: decryptor returned a parsed plaintext (not a string) for ${String(body.id)}; verified by JCS re-canonicalisation only (semantic, not byte, equivalence)`,
      );
    }

    body = mergeDecrypted(body, decrypted.parsed);
  }

  return buildTemplateData(body, templateConfig, protocolInfo, localePaths);
};

/**
 * PURE collection filter: applies one collection's `filters` to an injected
 * `allDeals[]` array. No chain, no fetch. Shared by production
 * `fetchCollections` and the dev render action (which injects `allDeals[]` or
 * pre-built collections).
 */
export const filterCollection = (allDeals: any[], collection: any): any[] => {
  let results = allDeals;

  if (collection.filters !== undefined) {
    results = results.filter((item: any) =>
      collection.filters!.every((filter: any) =>
        Object.entries(filter).every(([key, value]) => {
          const itemVal = item[key];
          return Array.isArray(itemVal) ? itemVal.includes(value) : itemVal === value;
        }),
      ),
    );
  }

  return results;
};

/**
 * PURE collection sorter: orders a filtered `items[]` per the collection's
 * optional `sortBy` key. Shared by production `fetchCollections` and the dev
 * render action (which injects `allDeals[]`).
 *
 *   'position'      -> ascending by Number(a.position) - Number(b.position)
 *   'creationDate'  -> ascending by Date.parse(creationDate)
 *   'modifiedDate'  -> ascending by Date.parse(modifiedDate)
 *   'title'         -> ascending alphabetically by String(title)
 *   absent/other    -> DEFAULT: ascending alphabetically by String(title)
 *
 * Defensive: missing/null/non-parseable fields sort LAST (treated as empty),
 * matching the numeric-position convention in renderer/handlebars-helpers.ts.
 * Returns a NEW array (never mutates the input).
 */
export const sortCollection = (items: any[], collection: any): any[] => {
  const sortBy = collection?.sortBy;
  const itemsCopy = items.slice();

  // Treat null / undefined / empty string as missing -> sorts last.
  const missing = (v: any) => v == null || v === '';

  const sortKey = (item: any): string | number | undefined => {
    if (sortBy === 'position') {
      const raw = item?.position;
      if (missing(raw)) return undefined;
      const n = Number(raw);
      return Number.isNaN(n) ? undefined : n;
    }
    if (sortBy === 'creationDate' || sortBy === 'modifiedDate') {
      const raw = item?.[sortBy];
      if (missing(raw)) return undefined;
      const t = Date.parse(raw);
      return Number.isNaN(t) ? undefined : t;
    }
    // 'title' or absent -> default alphabetical by title
    const title = item?.title;
    return missing(title) ? undefined : String(title);
  };

  return itemsCopy.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    // Missing/null/non-parseable values sort last (treated as empty).
    if (ka === undefined && kb === undefined) return 0;
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
    return String(ka).localeCompare(String(kb));
  });
};

/**
 * PURE: assemble the deal-ordered body list from a reconcile result.
 *
 * `fresh` (Map<genesis, body> — archive bodies) and `fetched` (bodies for the
 * `needsFetch` entries, same order) are merged into one per-genesis map, then
 * emitted in deal order — identical ordering to `fetchByPublication` (which
 * maps over getDeals order), so the filter/sort/decrypt chain sees
 * byte-identical input. Bodies that failed to fetch (null) are skipped.
 */
export const bodiesFromReconcile = (
  deals: Entry[],
  fresh: Map<string, any>,
  needsFetch: Entry[],
  fetched: (any | null)[],
): any[] => {
  const byGenesis = new Map<string, any>();
  for (const [genesis, body] of fresh) byGenesis.set(genesis, body);
  needsFetch.forEach((entry, i) => {
    const body = fetched[i];
    if (body != null) byGenesis.set(entry.genesis, body);
  });
  return deals.map((d) => byGenesis.get(d.genesis)).filter((b) => b != null);
};

/**
 * The drift the archive read path observed, surfaced for the T4 write-back.
 *
 *  - `deals`        — the deal set reconciled against (the freshness oracle);
 *  - `needsFetch`   — entries classified MISS/STALE by reconcile() (drift > 0);
 *  - `fetchedItems` — the FULL canonical items fetched fresh for those drift
 *    entries, keyed by genesis (what mergeArchive() stores — the flat toBody
 *    bodies the read path consumes are NOT enough for the archive).
 *
 * `null` only when the read path has nothing to hand the write-back: no
 * collections at all, or the archive pointer WAS set but the archive cat
 * failed (no-archive fallback — nothing to merge into).
 *
 * When the pointer is empty (cache never bootstrapped), the no-archive path
 * now surfaces a NON-NULL bootstrap drift (deals = all entries, needsFetch =
 * all entries, fetchedItems = the full freshly-fetched items) so the
 * maintainer render can SEED the first archive snapshot instead of deadlocking
 * forever on the N-cat path.
 */
export interface CollectionsDrift {
  deals: Entry[];
  needsFetch: Entry[];
  fetchedItems: Map<string, AnyS2SContentItem>;
}

/**
 * PURE drift-gating decision for the T4 archive write-back.
 *
 * A write fires only when ALL of these hold:
 *  - the job is the designated cache maintainer: `maintainCache === true` —
 *    the zod field has NO `.default(false)`, so `undefined` must be treated
 *    as falsy (never assume it is set);
 *  - not preview (preview runs on the free Bun runner and stays read-only);
 *  - the read path used the archive AND reconcile() found missing/stale items
 *    (drift > 0). Steady state (drift === 0) performs zero writes — read-only.
 *
 * Doubles as a type predicate on `drift`: when it returns true, `drift` is
 * non-null, so callers can hand it straight to the write-back without a
 * second narrowing.
 */
export const shouldWriteBackCache = (
  maintainCache: boolean | undefined,
  preview: boolean | undefined,
  drift: CollectionsDrift | null,
): drift is CollectionsDrift =>
  maintainCache === true && !preview && !!drift && drift.needsFetch.length > 0;

/**
 * One skipped item on the collection read path.
 *
 * The shape is module.factory's ItemSkip minus the parts the availability
 * channel does not use: `cause` mirrors the direct read path's classification
 * ('unavailable' = could not be read/malformed, 'integrity' = arrived and is
 * not what the author signed), so a consumer sees ONE taxonomy no matter which
 * read path produced the skip.
 */
type CollectionSkip = Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'> & {
  cause?: ItemFailureKind;
};

/** Mirror of module.factory's classification for a rejected refetch. */
const causeOf = (code: string): ItemFailureKind =>
  code === 'malformed-item' ? 'unavailable' : 'integrity';

/** One-line tally of integrity issue codes (bounded log, no per-item spam). */
const summariseIssues = (issues: IntegrityIssue[]): string => {
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.code, (counts.get(i.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, n]) => `${code}×${String(n)}`).join(', ');
};

/**
 * Archive-backed collection source: one cat of the archive + a bounded drift
 * refetch, instead of N cats per deal'd item.
 *
 *   deals    = getDeals()                      # freshness oracle (1 RPC)
 *   archive  = parseArchive(cat(archiveCid))   # 1 IPFS cat
 *   { fresh, needsFetch } = reconcile(deals, archive)
 *   fetched  = cat + toBody each needsFetch entry (bounded — the drift)
 *   bodies   = bodiesFromReconcile(deals, fresh, needsFetch, fetched)
 *
 * The archive's stored items are flattened per deal through `toBody(deal, item)`
 * inside reconcile() — so archive-served bodies carry exactly the same shape
 * (including the identity fields toBody emits) as the cold path's. Every item is
 * run through the shared integrity verdict (inspectItemIntegrity, bound to the
 * on-chain deal author) before being served; a 'mismatch' is NEVER served, is
 * reported through `skips`, and is refetched from the on-chain deal cid (where
 * the same verdict gate applies again via judgeRefetchedItem — a cat is not
 * authorship). Encrypted items are only author-bound here (their body is
 * ciphertext). The plaintext is verified at the first point it exists: the page
 * body in initTemplateData below, and every encrypted COLLECTION item in
 * render/main.ts (both hash the decryptor's raw string through
 * module.factory.verifyDecryptedBody).
 *
 * Alongside the bodies it surfaces the observed `drift` (deals + needsFetch +
 * the FULL fetched items) for the T4 write-back — see CollectionsDrift. On
 * archive cat failure it degrades to the no-archive path with `drift: null`
 * (nothing to merge into ⇒ the write-back must not fire).
 */
const fetchCollectionsFromArchive = async (
  archiveCid: string,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{
  bodies: any[];
  drift: CollectionsDrift | null;
  skips: CollectionSkip[];
}> => {
  // Cat the archive FIRST, wrapped: if the pointer is set but the blob is
  // unavailable (gateway hiccup, IPFS GC, unpinned), degrade to the exact
  // no-archive path (today's N cats) rather than fail the render — the cache
  // is a performance optimization, getDeals is the correctness oracle.
  // getDeals is intentionally NOT wrapped: the no-archive path calls it too,
  // so it fails identically either way. Catting first also means a cat failure
  // never wastes the getDeals RPC.
  let archive: Archive;
  try {
    archive = parseArchive(await catFile(gateway!, archiveCid));
  } catch (e) {
    console.warn(
      `archive cat failed, falling back to no-archive: ${e instanceof Error ? e.message : String(e)}`,
    );
    const fb = await fetchByPublicationWithSkips(publicationModule, rpcs, gateway);
    return { bodies: fb.bodies, drift: null, skips: fb.skips };
  }

  const deals = await getDeals(publicationModule, rpcs);
  const { fresh, needsFetch, integrityIssues } = reconcile(deals, archive);

  // Tamper evidence reaches the CALLER, not just the action log: the same
  // `skips` channel (non-fatal `availability` entries) that reports a failed
  // refetch also reports "the cache pointer was serving a rejected item". A
  // genesis that is then successfully refetched is still served — the note says
  // the archive entry was refused, which is exactly the signal an operator
  // needs to repoint the pointer.
  const skips: CollectionSkip[] = [];
  if (integrityIssues.length > 0) {
    console.warn(
      `archive integrity: ${String(integrityIssues.length)} archive item(s) REJECTED (${summariseIssues(
        integrityIssues,
      )}); refetching from the on-chain cid: ${integrityIssues.map((i) => i.genesis).join(', ')}`,
    );
    for (const issue of integrityIssues) {
      skips.push({
        genesis: issue.genesis,
        cid: issue.cid,
        cause: causeOf(issue.code),
        reason: skipReason(
          causeOf(issue.code),
          issue.code,
          `${issue.reason} — archive entry refused, refetched from the on-chain cid`,
        ),
      });
    }
  }

  // Track the FULL canonical items fetched fresh for the drift entries, keyed
  // by genesis — the T4 write-back merges these into the next archive
  // snapshot. The flat bodies below keep the read path byte-identical.
  const fetchedItems = new Map<string, AnyS2SContentItem>();
  const fetched = await Promise.all(
    needsFetch.map(async (entry) => {
      let item: unknown;
      try {
        item = JSON.parse(await catFile(gateway!, entry.cid));
      } catch (e) {
        // Genuinely unavailable: gateway/IPFS failure. Distinct from "the bytes
        // arrived and are bad", which is reported below with its own reason.
        const reason = skipReason(
          'unavailable',
          null,
          `IPFS retrieval failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        console.warn(`fetchCollections archive: skip ${entry.genesis} (${entry.cid})`, reason);
        skips.push({ genesis: entry.genesis, cid: entry.cid, cause: 'unavailable', reason });
        return null;
      }
      // Shape first, then integrity — the same policy maintain-cache uses
      // (judgeRefetchedItem). A null/array/string cat result must not be
      // mislabelled "retrieval failed", and a body that is not bound to the
      // author (author binding + plaintextHash + objectId + proof) is never
      // served, even from the content-addressed cid: a cat is not authorship.
      const verdict = judgeRefetchedItem(item, entry.author, entry.genesis, entry.cid);
      if (!verdict.usable) {
        const cause = causeOf(verdict.integrity.code);
        const reason = skipReason(
          cause,
          verdict.integrity.code,
          `refetched item rejected: ${verdict.integrity.reason}`,
        );
        console.warn(`fetchCollections archive: skip ${entry.genesis} (${entry.cid})`, reason);
        // NEVER cached: a rejected refetch must not enter the next archive
        // snapshot (fetchedItems is what mergeArchive stores).
        skips.push({
          genesis: entry.genesis,
          cid: entry.cid,
          cause,
          reason,
        });
        return null;
      }
      // Cast needed: JSON.parse yields `unknown`, and judgeRefetchedItem
      // returns a verdict, not a narrowed value. The verdict above is what makes
      // the claim true — canonical layout, body bound to the author.
      const canonical = item as AnyS2SContentItem;
      fetchedItems.set(entry.genesis, canonical);
      return toBody(entry, canonical);
    }),
  );
  return {
    bodies: bodiesFromReconcile(deals, fresh, needsFetch, fetched),
    drift: { deals, needsFetch, fetchedItems },
    skips,
  };
};

export const fetchCollections = async (
  templateConfig: S2STemplateConfig,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
  archiveCid?: string,
): Promise<{
  collections: Record<string, any[]>;
  drift: CollectionsDrift | null;
  skips: CollectionSkip[];
}> => {
  const collections: any = {};
  let drift: CollectionsDrift | null = null;
  let skips: CollectionSkip[] = [];

  // Fetch all deals once — every collection filters the same set.
  let allDeals: any[] = [];
  if ((templateConfig.collections || []).length > 0) {
    if (archiveCid) {
      const res = await fetchCollectionsFromArchive(archiveCid, publicationModule, rpcs, gateway);
      allDeals = res.bodies;
      drift = res.drift;
      skips = res.skips;
    } else {
      // NO-ARCHIVE BOOTSTRAP path (archive pointer empty — cache never written).
      // Capture the full freshly-fetched items + the deals IN THE SAME SINGLE
      // PASS that builds the bodies (fetchByPublicationDetailed — never a
      // second fetch) and surface a NON-NULL bootstrap CollectionsDrift:
      //   deals       = all deal entries;
      //   needsFetch  = all entries (nothing is cached yet ⇒ everything is a MISS);
      //   fetchedItems= every freshly-fetched content item keyed by genesis.
      //
      // This is what un-deadlocks the cache: shouldWriteBackCache now sees
      // needsFetch > 0 (before, drift was null and the write-back never fired),
      // so the maintainer render SEEDS the archive instead of staying forever on
      // the N-cat path. With no deals there is nothing to fetch — drift keeps
      // needsFetch empty and no write fires (steady state).
      const res = await fetchByPublicationDetailed(publicationModule, rpcs, gateway);
      allDeals = res.bodies;
      drift = {
        deals: res.entries,
        needsFetch: res.entries,
        fetchedItems: res.items,
      };
      skips = res.skips;
    }
    allDeals = allDeals.filter((item) => item != null);
  }

  for (const collection of templateConfig.collections || []) {
    collections[collection.slug] = sortCollection(
      filterCollection(allDeals, collection),
      collection,
    );
  }

  return { collections, drift, skips };
};

// export const decryptCollection = async (collection: any, publicationModule: string, authorSafeAddress: string) => {

//   return await Promise.all(
//     collection.map(async (item: any) => {
//         return await _decryptAndMerge(item, publicationModule, authorSafeAddress);
//     })
//   );
// };

const processBase = () => {
  // Merge collections from body.base with collected arrays
  // if (body.base) {
  //   // First, handle keys that exist in both collections and body.base
  //   for (const key in collections) {
  //     if (body.base[key] && Array.isArray(body.base[key])) {
  //       // Create a map of existing items in collections using a unique identifier
  //       const collectionMap = new Map();
  //       collections[key].forEach((item: any) => {
  //         // Using stream_id as the unique identifier
  //         if (item.stream_id) {
  //           collectionMap.set(item.stream_id, item);
  //         }
  //       });
  //       // Merge items from body.base[key], prioritizing items from collections
  //       for (const item of body.base[key]) {
  //         if (item.stream_id && !collectionMap.has(item.stream_id)) {
  //           let _templateConfig = config.mapping.templateConfig.find(
  //             (m: any) => m.reference === item.post_type
  //           );
  //           if (_templateConfig != undefined) {
  //             item.path = createPath(item, _templateConfig);
  //           }
  //           collections[key].push(item);
  //         }
  //       }
  //     }
  //   }
  //   // Then, add keys that only exist in body.base but not in collections
  //   if (typeof body.base === "object") {
  //     Object.keys(body.base).forEach((key) => {
  //       const baseArray = body.base![key];
  //       if (!collections[key] && Array.isArray(baseArray)) {
  //         collections[key] = [...baseArray];
  //       }
  //     });
  //   }
  // }
  // delete body.base;
};
