import { decrypt } from '../libs/decrypt';
import {
  fetchByPublication,
  fetchByPublicationDetailed,
  getDeals,
  toBody,
  type Entry,
} from '../libs/module.factory';
import { catFile } from '../libs/ipfs.factory';
import { parseArchive, reconcile, type Archive } from '../libs/archive.factory';
import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { transformContent } from './content-transforms';

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

export const mergeDecrypted = (body: S2SBodyEncrypted, decrypted: any): S2SBodyPlain => {
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
    const decrypted = await decrypt(
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
    body = mergeDecrypted(body, decrypted);
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
  fetchedItems: Map<string, S2SContentItem>;
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
 * Archive-backed collection source: one cat of the archive + a bounded drift
 * refetch, instead of N cats per deal'd item.
 *
 *   deals    = getDeals()                      # freshness oracle (1 RPC)
 *   archive  = parseArchive(cat(archiveCid))   # 1 IPFS cat
 *   { fresh, needsFetch } = reconcile(deals, archive)
 *   fetched  = cat + toBody each needsFetch entry (bounded — the drift)
 *   bodies   = bodiesFromReconcile(deals, fresh, needsFetch, fetched)
 *
 * The archive's stored bodies ARE the flat toBody output, so the returned
 * bodies feed filterCollection/sortCollection byte-identically to today.
 * Encrypted items arrive as their encrypted toBody shape (meta + ciphertext)
 * and are decrypted downstream in render/main.ts — the archive never bypasses
 * decryption and never stores decrypted plaintext.
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
): Promise<{ bodies: any[]; drift: CollectionsDrift | null }> => {
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
    return { bodies: await fetchByPublication(publicationModule, rpcs, gateway), drift: null };
  }

  const deals = await getDeals(publicationModule, rpcs);
  const { fresh, needsFetch } = reconcile(deals, archive);

  // Track the FULL canonical items fetched fresh for the drift entries, keyed
  // by genesis — the T4 write-back merges these into the next archive
  // snapshot. The flat bodies below keep the read path byte-identical.
  const fetchedItems = new Map<string, S2SContentItem>();
  const fetched = await Promise.all(
    needsFetch.map(async (entry) => {
      try {
        const item = JSON.parse(await catFile(gateway!, entry.cid));
        fetchedItems.set(entry.genesis, item as S2SContentItem);
        return toBody(entry, item);
      } catch (e) {
        console.warn(`fetchCollections archive: skip ${entry.genesis} (${entry.cid})`, e);
        return null;
      }
    }),
  );
  return {
    bodies: bodiesFromReconcile(deals, fresh, needsFetch, fetched),
    drift: { deals, needsFetch, fetchedItems },
  };
};

export const fetchCollections = async (
  templateConfig: S2STemplateConfig,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
  archiveCid?: string,
): Promise<{ collections: Record<string, any[]>; drift: CollectionsDrift | null }> => {
  const collections: any = {};
  let drift: CollectionsDrift | null = null;

  // Fetch all deals once — every collection filters the same set.
  let allDeals: any[] = [];
  if ((templateConfig.collections || []).length > 0) {
    if (archiveCid) {
      const res = await fetchCollectionsFromArchive(archiveCid, publicationModule, rpcs, gateway);
      allDeals = res.bodies;
      drift = res.drift;
    } else {
      // NO-ARCHIVE BOOTSTRAP path (archive pointer empty — cache never written).
      // Capture the full freshly-fetched items + the deals IN THE SAME SINGLE
      // PASS that builds the bodies (fetchByPublicationDetailed — never a
      // second fetch) and surface a NON-NULL bootstrap CollectionsDrift:
      //   deals       = all deal entries;
      //   needsFetch  = all entries (nothing is cached yet ⇒ everything is a MISS);
      //   fetchedItems= every freshly-fetched S2SContentItem keyed by genesis.
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
    }
    allDeals = allDeals.filter((item) => item != null);
  }

  for (const collection of templateConfig.collections || []) {
    collections[collection.slug] = sortCollection(
      filterCollection(allDeals, collection),
      collection,
    );
  }

  return { collections, drift };
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
