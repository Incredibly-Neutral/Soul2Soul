import { evmRead } from "./evm";
import { catFile } from "./ipfs.factory";

// ── Module ABIs (Base) ────────────────────────────────────────────────────
// Entry tuple returned by getLatest / getDeals / getOffers.
const ENTRY_COMPONENTS = [
  { name: "genesis", type: "bytes32" },
  { name: "author", type: "address" },
  { name: "cid", type: "string" },
  { name: "timestamp", type: "uint256" },
];

const MODULE_ABI = [
  {
    type: "function", name: "getLatest", stateMutability: "view",
    inputs: [{ name: "genesis", type: "bytes32" }],
    outputs: [{ name: "", type: "tuple", components: ENTRY_COMPONENTS }],
  },
  {
    type: "function", name: "getDeals", stateMutability: "view",
    inputs: [{ name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }],
    outputs: [{ name: "", type: "tuple[]", components: ENTRY_COMPONENTS }],
  },
];

export interface Entry {
  genesis: string;
  author: string;
  cid: string;
  timestamp: number;
}

const toEntry = (e: any): Entry => ({
  genesis: e.genesis,
  author: e.author,
  cid: e.cid,
  timestamp: Number(e.timestamp),
});

// ── Adapter: S2SContentItem (IPFS) → flat S2SBody (what the pipeline expects) ──
// Mirrors the old lens formatSingle: encrypted → body carries the ciphertext;
// plain → spread the parsed body. Keeps downstream (data.ctrlr, decrypt,
// config.ctrl) unchanged.
export const toBody = (entry: Entry, item: any): any => {
  const p = item.public;
  const base = {
    id: entry.genesis,                 // job identity is the genesis
    author: p.author,           // did:ethr:0x... — pass through from IPFS
    locale: p.locale,
    parent: p.parent,
    position: p.position,
    postType: p.postType,
    creationDate: String(p.createdAt), // this version's timestamp
    modifiedDate: String(p.createdAt),
    tags: p.tags,
    attributes: p.attributes,
    publication: p.publication,
    base: p.base,
  };

  if (item.encryption) {
    // content is the ciphertext string; decrypt.ts does JSON.parse(body.content)
    return { ...base, encryption: true, content: item.body };
  }

  const parsed = JSON.parse(item.body); // { title, slug, content, custom? }
  return {
    ...base,
    encryption: false,
    content: parsed.content,
    title: parsed.title,
    slug: parsed.slug,
    custom: parsed.custom,
  };
};

// ── Reads ─────────────────────────────────────────────────────────────────

export const getLatestEntry = async (
  genesis: string,
  publicationModule: string,
): Promise<Entry> => {
  const e = await evmRead("BASE", publicationModule, MODULE_ABI, "getLatest", [genesis]);
  return toEntry(e);
};

/** Enumerate all deals for this publication (paginated). Entry.cid is the latest. */
export const getDeals = async (
  publicationModule: string,
  pageSize = 200,
): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page: any[] = await evmRead(
      "BASE", publicationModule, MODULE_ABI, "getDeals", [offset, pageSize],
    );
    for (const e of page) out.push(toEntry(e));
    if (page.length < pageSize) break;
  }
  return out;
};

// ── Drop-in replacements for lens.factory ─────────────────────────────────

/** Replaces lens.factory `fetchById`. Reads latest cid from the module, cats from IPFS. */
export const fetchById = async (
  genesis: string,
  publicationModule: string,
): Promise<any> => {
  const entry = await getLatestEntry(genesis, publicationModule);
  if (!entry.cid) return undefined;
  const item = JSON.parse(await catFile(entry.cid));
  return toBody(entry, item);
};

/**
 * Replaces lens.factory `fetchByQuery` for the "filter by publication" case.
 * The module instance IS the publication, so this is getDeals() + cat each cid.
 */
export const fetchByPublication = async (
  publicationModule: string,
): Promise<any[]> => {
  const entries = await getDeals(publicationModule);
  const bodies = await Promise.all(
    entries.map(async (entry) => {
      try {
        const item = JSON.parse(await catFile(entry.cid));
        return toBody(entry, item);
      } catch (e) {
        console.warn(`fetchByPublication: skip ${entry.genesis} (${entry.cid})`, e);
        return null;
      }
    }),
  );
  return bodies.filter((b): b is any => b != null);
};
