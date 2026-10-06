# Findings — Off-chain discovery/resolution surface for an external indexer (CASE 1)

> Design study (read-only). Task: given an on-chain pointer, how does one resolve the actual
> **rendered website / readable location** of a publication and its content. Grounded in code
> + specs, not the whitepaper's aspirational text. Scope: the ENS → site-root → per-page chain.
>
> Date: 2026-09-10. Workspace: `/home/joera/code/s2s`. **Note:** `cid-mirror` lives at
> `/home/joera/code/s2s/cid-mirror` (NOT `/home/joera/code/cid-mirror` as the task brief guessed).

---

## (a) The exact resolution chain: publication identity → readable site root

There are **two** distinct "root CID" pointers and **two** distinct identity spaces an indexer must
not conflate:

| Pointer | Stored where | What it is | Written by |
|---|---|---|---|
| `contenthash_wrapped` | L2 `ENSSubdomainRecordsContract` (`ENSL2nRecords.sol`), keyed by `namehash(writeDomain)` | **Site root CID** (the rendered site tree) | the PKP via the UPDATE action (INV-6/INV-12) |
| `content_cache_<publication>` | same L2 records contract, keyed by `namehash(publication)` | **Content archive CID** (genesis-keyed canonical items) | the PKP via the maintain-cache action |

### 1. Publication → ENS node

A publication is an ENS subdomain of `soul2soul.eth`. The node is `namehash(name)`
(e.g. `alice.soul2soul.eth`). `cid-mirror/src/ens.ts::namehash` (and the Solidity
`ENSResolverWithCCIP.sol::namehash`) implement EIP-137. **Important gotcha:** the write target is
`namehash(writeDomain)` where `writeDomain = config.domain ?? publication` — `protocol/actions/src/update/main.ts` (the `writeDomain` block). So an indexer must read the config's optional `domain` to know the *actual* node the root lives at; it is **not always** `namehash(publication)`.

### 2. Records-contract address (the L2 store)

Not a constant. Discovered per-run by mirroring `protocol/actions/src/libs/ens.factory.ts::getProtocolControllerAndModules` + `protocol.factory.ts::getProtocolInfo`:

```
L1 registry.nameWrapper()                      → nameWrapper addr
L1 nameWrapper.ownerOf(namehash('soul2soul.eth')) → ENSOpenSubdomainRegistry (C4)
L1 customRegistry.parentDomainController()     → protocol controller (publication multisig)
L2 controller.getModulesPaginated(0x…01,10)    → modules; probe NAME()=='S2S Records Module' → configModule
L2 configModule.getRecords([...keys])          → element[1] = 'ens_records' → ENSL2nRecords (C3)
```

`cid-mirror/src/ens.ts::getProtocolInfo` implements this with raw `eth_call` (selectors +
ABI-encode/decode), and supports a `RECORDS_CONTRACT` env override to skip discovery. The canonical
implementation is in `ens.factory.ts` / `protocol.factory.ts` (uses `evmRead` on the S2SRecordsModule
ABI). Note the `getRecords` return is `string[]` (literal strings, not ABI `address` words) — this
was a real bug (`getRecords string[] ABI fix`, PR #80), so an indexer decoding it as padded `address`
words will silently misparse.

### 3. Read the site-root pointer (L2)

```
ensRecords.getText(namehash(writeDomain), 'contenthash_wrapped')   // view, on Base 8453
```

`ENSL2nRecords.sol::getText` (lines ~147–154) returns `textRecords[node][key]`. The value is the
**EIP-1577 ipfs-ns contenthash** `0xe3 0x01 <CID bytes>`. Decode:
`cid-mirror/src/ipfs/contenthash.ts::decodeContenthashWrapped` (vendored verbatim from
`shared/src/ipfs/contenthash.ts`). `protocol/actions/src/libs/ipfs.factory.ts::contenthashToIPFS` is
the on-chain-write-side inverse; `evm.ts::toHexString` is the encode side (UPDATE).

**This is the whole site tree.** The root CID is a UnixFS (dag-pb) directory CID. There is
**no `contenthash` on Ethereum mainnet** — the L1 `ENSResolverWithCCIP` defers to L2 via CCIP-Read.

### 4. The CCIP-Read path (why a browser resolves it — indexers can skip it)

For an ordinary ENS client: `alice.soul2soul.eth` → L1 resolver `ENSResolverWithCCIP.sol`
(`contenthash()` / `resolve()`) → `revert OffchainLookup(rpcUrls, abi.encode(C3, getText(node,key)))`
→ client POSTs to `ccip_gateway/src/main.ts` → gateway `eth_call`s `getText` on C3 (Base) → returns
bytes → callback `resolveContenthashCallback` decodes. **An indexer does NOT need CCIP at all**: it
can call `getText` directly on the L2 records contract (that's exactly what cid-mirror does, bypassing
the gateway). The gateway is only the browser-facing bridge.

---

## (b) How content maps to URLs within a site

### The site tree layout (built by UPDATE)

`protocol/actions/src/update/main.ts` assembles an IPFS **MFS tree** and pins it; the pinned root is
what `contenthash_wrapped` points at. Layout:

```
<root CID>/
  index.html                 ← home page (job.path === 'index.html')
  <postPath>/index.html      ← every rendered page is a DIRECTORY with index.html
  assets/…                   ← config.assetsCid copied whole into /assets
```

Exact rules (update/main.ts):
- Each rendered `job` is written to `mfsPath/<job.path>/index.html`, **except** `job.path === 'index.html'` which writes `mfsPath/index.html` (the copy branch: `const filePath = job.path === 'index.html' ? 'index.html' : `${job.path}/index.html``).
- On a delta publish the previous root tree is copied first (`files/cp /ipfs/<prevCid>`) then changed paths are `rm` + `cp` (kubo cp does not overwrite), then `remove[]` entries (slug renames / revocations) are deleted, then `/assets` is re-copied from `config.assetsCid`.
- `node = namehash(writeDomain)` is then written on-chain (INV-6).

### How `job.path` is derived (URL path from content)

`protocol/actions/src/render/data.ctrlr.ts::createPath`:

```ts
path = (localePaths?.[body.locale] ?? localePaths?.default ?? '') + templateConfig.path
if (!body.encryption && body.slug && path.includes('{slug}'))
    path = path.replace('{slug}', body.slug)
```

- `templateConfig` is matched by `reference === body.postType` in the publication config's
  `mapping.templateConfig` (`config.ctrl.ts::getTaskConfig`, `data.ctrlr.ts::pathsForCollections`).
- `templateConfig.path` is a per-template output URL pattern, e.g. `path: '/{slug}'` for a `post`
  template (see `shared/src/rendering/fixtures/inputs.ts::sampleTemplateConfig` and
  `shared/src/protocol/types.ts::S2STemplateConfig`).
- `localePaths` (optional `{ locale: prefix }`) prepends a locale prefix (e.g. `/en`); the legacy
  hardcoded nl/en scheme is described in `SUMMARY-protocol.md` §6 and superseded by
  `config.localePaths` (SUMMARY §7).
- **Encrypted bodies do NOT substitute the slug** — they keep the bare template path (no `{slug}`
  replacement, because the slug is inside the ciphertext).

So: a plaintext post with slug `hello-world` under a template with `path: '/{slug}'` → `job.path =
'/hello-world'` → rendered file at `<rootCID>/hello-world/index.html` → public URL
`https://alice.soul2soul.eth.limo/hello-world/`. This exactly matches the fixture
`sampleJob.path === '/hello-world'`.

### Given a deal/genesis, can an indexer find the rendered page?

**Partially — on-chain gives you the content, not the URL.** The deal→content hop is on-chain:

- `publicationModule.getDeals(offset,limit)` returns `Entry[] = {genesis, author, cid, timestamp}`
  (`protocol/actions/src/libs/module.factory.ts`). `cid` is the IPFS CID of the canonical content
  item (`S2SContentItem`) — the *input* to rendering, not the rendered page.
- `getLatest(genesis)` / `getVersion` / `getVersionCount` give the item's version history.

To turn `genesis` into a rendered URL an indexer must additionally fetch **off-chain**:
1. The content item from IPFS at `entry.cid` (`toBody`, module.factory.ts) → get `postType`, `locale`, and the slug.
2. The slug lives in `item.body` (JSON `{title,slug,content,custom}`) **only if `encryption:false`**.
   If `encryption:true`, the slug is **inside the ciphertext and not derivable** without the PKP/decryption key — a hard wall for a plain public indexer.
3. The publication config (`getRecord('config')` on configModule → IPFS CID → `mapping.templateConfig` + `localePaths`) to compute `createPath`.

So the genesis→URL mapping is **NOT** derivable on-chain alone; it needs the config (IPFS) and, for
encrypted items, decryption. The *on-chain* portion is: deal → genesis → content CID. The rest is off-chain.

---

## (c) What an indexer must fetch off-chain vs on-chain

| Step | Data | Source | On/Off chain |
|---|---|---|---|
| Enumerate publications | subdomain labels + owners | `SubdomainRegistered` **event logs** (only enumerable surface) | **On-chain** |
| Resolve name → root CID | `contenthash_wrapped` | `getText` on L2 `ENSL2nRecords` | **On-chain** (L2) |
| Records-contract address | protocol layout | L1+L2 `eth_call` walk (ens.factory/protocol.factory) | **On-chain** |
| Site tree structure | dir/CID listing | kubo `/api/v0/ls` recursive | **Off-chain** (IPFS) |
| Site leaf bytes | page HTML / assets | kubo `/api/v0/cat` | **Off-chain** (IPFS) |
| Deal → content CID | `{genesis,author,cid,timestamp}` | `getDeals` on publication module | **On-chain** (L2) |
| Content item (postType/locale/slug) | `S2SContentItem` | IPFS cat at `entry.cid` | **Off-chain** (IPFS) |
| Config (mapping.templateConfig, localePaths, assetsCid, domain, templateCid) | `S2SPublicationConfig` | `getRecord('config')` → IPFS CID | pointer on-chain, body **off-chain** |
| Encrypted item's slug/title/content | ciphertext | decrypt via PKP | **Neither** (needs key) |
| Content archive (genesis→items) | `Archive` | `content_cache_<publication>` → IPFS | pointer on-chain, body **off-chain** |

The `data_gateway` (kubo) URL itself is a protocol record (`getRecords` element[0]) — an indexer
needs it for all IPFS fetches. It's on-chain (protocol-level), but the data behind it is off-chain.

---

## (d) Existing index/listing surfaces (is there already a publication/content index?)

**There is no global, server-side, cross-publication index.** What exists:

1. **`cid-mirror`** (`cid-mirror/src/{ens,mirror,api,index}.ts`) — a per-publication mirror. Resolves
   `PUBLICATION_URL` → root CID (exactly the chain in (a)), traverses the kubo tree, downloads every
   leaf to `webcontent/` preserving URL structure, serves `POST /api/refresh`, `GET /api/status`
   (reports `rootCid`, `files`, `refreshedAt`), `GET /healthz`. This is the **closest existing
   "readable site" resolution primitive** an indexer should copy. It is *one publication per instance*.
2. **safe-app website-tree tab** (`safe-app/src/components/s2s-website-tree-tab.ts`) — reads
   `contenthash_wrapped`, walks the DAG from the root via `decodeRootCid` (`lib/contenthash.ts`),
   renders a collapsible per-publication tree, and diffs snapshots to surface retractions/slug
   renames. Interactive UI, per-publication, not a durable index.
3. **safe-app records tab** (`s2s-records-tab.ts`) — the *configModule* KV records of one publication
   (key/value config), plus Filecoin storage items. **Not a content index.**
4. **maintain-cache action** (`protocol/actions/src/maintain-cache/main.ts` + `archive.factory.ts`) —
   writes `content_cache_<publication>`: an IPFS **`Archive`** (`ARCHIVE_FORMAT='s2s-publication-archive/2'`)
   of `{ genesis: {cid, item: S2SContentItem} }`. This is the **most index-like off-chain surface
   that already exists**: a genesis-keyed snapshot of all canonical content items for a publication.
   It is consumed by the render path (`data.ctrlr.ts::fetchCollectionsFromArchive`) as a freshness
   cache. An external indexer could read this pointer + archive instead of re-catting each deal.
   Caveats: it is maintained by the PKP/render pipeline (not guaranteed fresh), stores the full item
   (still ciphertext for encrypted ones), and is keyed by genesis only (no URL paths inside).
5. **`S2SRecordsModule.getAllKeys/getAllRecords`** (`S2SRecordsModule.sol` ~185–210) — protocol-level
   KV enumeration (gateways, action CIDs, PKP, `ens_records`), useful for bootstrap, not content.

**Publication enumeration gap:** `ENSOpenSubdomainRegistry.sol` keeps `registeredSubdomains` as a
`mapping(string=>bool)` — **not enumerable on-chain**. The only on-chain way to list publications is
to index the `SubdomainRegistered(subdomain, owner)` events. There is no public sitemap.xml, no
gateway index route, and no serverless discovery endpoint.

---

## (e) Gaps / open questions for the indexer

1. **No on-chain publication registry list** — you must watch `SubdomainRegistered` events; there is
   no `allSubdomains[]` array. (ENSOpenSubdomainRegistry.sol)
2. **`node = namehash(writeDomain)`** — `config.domain` can redirect the root write off the
   publication's own subdomain. An indexer resolving by `namehash(publication)` alone will miss
   publications with a custom `domain`. Must read config first (off-chain).
3. **Encrypted content is unresolvable to a URL by a public indexer** — slug lives in the ciphertext
   (`toBody` only exposes it for `encryption:false`). The rendered page path for an encrypted item
   uses the bare template path (no `{slug}`), so multiple encrypted items can collide at the same
   URL. Indexing *content* (vs. *pages*) for encrypted items requires access control.
4. **genesis→URL is not derivable on-chain** — needs config (IPFS) + slug (IPFS/decrypt) +
   `createPath`. The on-chain graph only gives genesis→content-CID and publication→root-CID.
5. **`contenthash_wrapped` codec is custom/unversioned** — `0xe3 0x01` envelope; generic ENS tooling
   may fail (SPEC-contracts-ens "Gotchas"). Must use `decodeContenthashWrapped`.
6. **Cross-client CCIP decode brittleness** (whitepaper DR-7.6) — irrelevant if the indexer reads L2
   directly, but relevant if it mirrors browser behavior through `.limo`/`.link`.
7. **`getRecords` returns `string[]` not `address[]`** — the PR #80 ABI fix; naive ABI decode of
   `ens_records` as a padded address word silently returns the wrong address.
8. **Config CID location** — `getRecord('config')` on the *configModule* (S2SRecordsModule), NOT the
   ENS records contract; and `config.assetsCid` / `config.templateCid` are separate IPFS trees the
   indexer must fetch for full-page + asset resolution.
9. **cid-mirror is single-publication** — no cross-publication orchestration/listing exists to build
   the "indexer" from directly; the pattern (resolve→ls→cat→disk) is per-instance.
10. **Archive freshness** — `content_cache_<publication>` is a render-pipeline cache; not guaranteed
    to exist or be current. Deal enumeration (`getDeals`) is the correctness oracle.

---

## (f) File / function list relied on

**Resolution chain (ENS → root CID)**
- `cid-mirror/src/ens.ts` — `namehash`, `extractEnsName`, `isEnsName`, `getProtocolController`,
  `getConfigModule`, `getRecordsContract`, `getProtocolInfo`, `getEnsRecords`, `resolveEnsToCID` (the
  complete indexer-relevant implementation; raw `eth_call`, selectors in `SEL`).
- `protocol/actions/src/libs/ens.factory.ts` — `getProtocolControllerAndModules`,
  `getDomainOwnerAndModules`, `KNOWN_NON_S2S_MODULES`, `mapWithLimit` (canonical discovery).
- `protocol/actions/src/libs/protocol.factory.ts` — `getProtocolInfo` (reads `getRecords` → ens_records at index 1, pkp, gateways, action CIDs).
- `protocol/contracts/contracts/ENSL2nRecords.sol` — `getText`, `setText`, `authorizeCaller`, `getRecords` (C3 store).
- `protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol` — `registerSubdomain`, `parentDomainController`, `registeredSubdomains` (C4; event source `SubdomainRegistered`).
- `protocol/contracts/contracts/ENSResolverWithCCIP.sol` — `contenthash`/`resolve` + OffchainLookup + `resolveContenthashCallback` (C5; browser path).
- `protocol/ccip_gateway/src/main.ts` — CCIP gateway (eth_calls C3 on Base; browser bridge; not needed by a direct-reading indexer).
- `shared/src/ipfs/contenthash.ts` (canonical) + `cid-mirror/src/ipfs/contenthash.ts` (vendored) — `decodeContenthashWrapped`, `parseCID`, `encodeContenthashWrapped`, `toPreviewLabel`.
- `protocol/actions/src/libs/ipfs.factory.ts` — `contenthashToIPFS` (decode side used by UPDATE/read path).
- `protocol/actions/src/libs/evm.ts` — `evmRead`, `evmWrite`, `toHexString` (write path).

**Content layout / URL derivation**
- `protocol/actions/src/update/main.ts` — MFS tree assembly: `job.path → <path>/index.html`, cp-root delta, `remove[]`, `/assets` from `config.assetsCid`, `node=namehash(writeDomain)`, `setText('contenthash_wrapped')`.
- `protocol/actions/src/render/data.ctrlr.ts` — `createPath` (locale prefix + `{slug}` substitution), `pathsForCollections`, `initTemplateData`, `buildTemplateData`.
- `protocol/actions/src/render/config.ctrl.ts` — `getConfig` (`getRecord('config')` → IPFS → `S2SPublicationConfig`), `getTaskConfig`.
- `shared/src/protocol/types.ts` — `S2STemplateConfig` (`reference/file/path/collections/filters`), `S2SRipple`, `IMapping`.
- `shared/src/publication/types.ts` + `validation.ts` — `S2SPublicationConfig` (assetsCid, contract, dataGateway, mapping, name, templateCid, localePaths?, domain?).
- `shared/src/rendering/fixtures/inputs.ts` — example `templateConfig` (`path:'/{slug}'`) and `sampleJob.path`.
- `protocol/actions/src/libs/module.factory.ts` — `Entry` (`genesis/author/cid/timestamp`), `getDeals`, `getLatest`, `toBody` (where slug is only visible for plaintext).
- `shared/src/ipfs/index.ts` / `cid-mirror/src/ipfs/kubo.ts` — kubo RPC (`ls`, `cat`, `dagGet`, `files/*`).

**Existing index-like surfaces**
- `cid-mirror/src/mirror.ts` — `Mirror`, `mapPath` (root→`index.html`), `refresh`, `downloadTree`, `downloadLeaf`; `cid-mirror/src/api/index.ts` (`/api/refresh`, `/api/status`).
- `safe-app/src/components/s2s-website-tree-tab.ts` — DAG walk from root, `decodeRootCid`, `content_cache_<publication>` footer.
- `safe-app/src/components/s2s-records-tab.ts` + `safe-app/src/lib/safe-integration.ts` — configModule `getAllRecords` (per-publication config KV).
- `protocol/actions/src/maintain-cache/main.ts` + `protocol/actions/src/libs/archive.factory.ts` — `Archive` (`s2s-publication-archive/2`), `parseArchive`, `reconcile`, `content_cache_<publication>` pointer.
- `protocol/contracts/contracts/S2SRecordsModule.sol` — `getRecord`, `getRecords`, `getAllKeys`, `getAllRecords` (configModule).

**Specs / whitepaper grounding**
- `brain/specs/SPEC-contracts-ens.md` (INV-6, INV-12, INV-4; C3/C4/C5), `brain/specs/RFC-cid-mirror.md` (accepted design), `brain/specs/SUMMARY-protocol.md` §2 (two record stores), §4–7 (mapping/paths), `brain/whitepaper/06-website-hosting.md`, `brain/whitepaper/07-domain-resolution.md` (DR-7.x), `brain/code-map/MAP.md`.
