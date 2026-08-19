import { decrypt } from '../libs/decrypt';
import { fetchByPublication, getDeals, toBody, type Entry } from '../libs/module.factory';
import { catFile } from '../libs/ipfs.factory';
import { parseArchive, reconcile, type Archive } from '../libs/archive.factory';
import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';
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
 */
const fetchCollectionsFromArchive = async (
  archiveCid: string,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<any[]> => {
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
    return fetchByPublication(publicationModule, rpcs, gateway);
  }

  const deals = await getDeals(publicationModule, rpcs);
  const { fresh, needsFetch } = reconcile(deals, archive);
  const fetched = await Promise.all(
    needsFetch.map(async (entry) => {
      try {
        const item = JSON.parse(await catFile(gateway!, entry.cid));
        return toBody(entry, item);
      } catch (e) {
        console.warn(`fetchCollections archive: skip ${entry.genesis} (${entry.cid})`, e);
        return null;
      }
    }),
  );
  return bodiesFromReconcile(deals, fresh, needsFetch, fetched);
};

export const fetchCollections = async (
  templateConfig: S2STemplateConfig,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
  archiveCid?: string,
) => {
  const collections: any = {};

  // Fetch all deals once — every collection filters the same set.
  let allDeals: any[] = [];
  if ((templateConfig.collections || []).length > 0) {
    allDeals = archiveCid
      ? await fetchCollectionsFromArchive(archiveCid, publicationModule, rpcs, gateway)
      : await fetchByPublication(publicationModule, rpcs, gateway);
    allDeals = allDeals.filter((item) => item != null);
  }

  for (const collection of templateConfig.collections || []) {
    collections[collection.slug] = sortCollection(
      filterCollection(allDeals, collection),
      collection,
    );
  }

  return collections;
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
