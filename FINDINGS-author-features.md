# Findings — private backup manifest + public curated publications list

Read-only investigation of `/home/joera/code/s2s` for two author-facing safe-app features:
(1) a **PRIVATE backup manifest** of every CID / Genesis-ID the author holds locally (restore after
machine loss), and (2) a **PUBLIC curated list** of the author's publications (genesis + publication
+ plain text) cross-referenced with the on-chain publication module. Design question:
**on-chain record = mapping only, or do we also push manifests to IPFS — and if so, how do
encryption/pinning work today.**

No files were changed. All line numbers verified against HEAD `45399a0`.

---

## Q1. RECORDS LAYOUT — how records are keyed in the publication `S2SRecordsModule` (INV-2)

### Short answer
`S2SRecordsModule` is a **generic `string→string` KV store** with **no key constraint** — the key
set is not enforced by the contract, only by readers/writers (that is exactly what INV-2 means). The
**canonical key list exists only for the protocol/controller** side (a header comment + `getRecords`
call), not for the publication side. **Values are arbitrary strings with no size limit, so a value
CAN be a CID** — in fact the `config` record already stores a CID (the config CID), and `repo` stores
a GitHub URL. Record values are short strings only by convention, not by construction.

### Evidence
- Contract is a plain KV, `onlySafe` writes, with enumeration:
  `protocol/contracts/contracts/S2SRecordsModule.sol`
  - `mapping(string => string) private records;` (L96), `string[] private recordKeys;` (L98) + `keyIndex`/`keyExists` (L99–100)
  - `setRecord`/`setRecords`/`deleteRecord` — all `modifier onlySafe` (L101, 109, 122, 131, 151)
  - Reads: `getRecord`/`getRecords`/`recordExists`/`getAllKeys`/`getAllRecords`/`getRecordCount`/`getKeyAtIndex` (L165–214)
  - `NAME = "S2S Records Module"` (L91), `VERSION = "1.1.0"` (L92), `safe` immutable (L94)
  - **No key allowlist, no value length check** anywhere.
- Canonical protocol-side key list — **the one place it is documented**: `shared/src/protocol/index.ts`
  - Header comment (L12–28): expects `data_gateway, ens_records, ens_registry, publication_factory, records_factory, pkp_ethAddress, lit_action_prep, lit_action_render, lit_action_update`; DROPPED `assets_gateway, lens_app, pkp_tokenId, pkp_publicKey, lit_action_cbor, lit_action_single, lit_action_root_update`; RENAMED `lit_action_single→lit_action_render`, `lit_action_root_update→lit_action_update`.
  - `getRecords(configModule, [...same keys..., 'lit_action_maintainCache', 'pkp_ethAddress'])` (L40–68).
- Actions re-state the same protocol key list: `protocol/actions/src/libs/protocol.factory.ts:20`.
- INV-2 definition: `brain/specs/SPEC-00-system-contract.md:208` (mirrors the above).
- **Publication-side keys are written at creation time**: `shared/src/publication/new.ts`
  - `setRecordsWithRetry` writes keys `['name','config','repo','branch','feed']` (L247–255).
  - `configCid` stored under `config`; `devRepository` under `repo`; `feed` = Lens feedAddress (L147–153).
- safe-app reads/writes `config`, `name`, `repo`: `safe-app/src/components/s2s-records-tab.ts`
  - `getRecord('config')` (L175, 236), `getRecord('name')` (L219, 238), `getRecord('repo')` (L252),
    `setRecord('config', configCid)` (L313).
- Actions read `config` from the publication module: `protocol/actions/src/render/config.ctrl.ts:12–19` (`getRecord ['config']`).
- The Records **tab is free-form** (no allowlist): `addRecord`/`updateRecord` accept any key/value; type is inferred by substring: `contentKeys = ['ipfs-root','content-hash','data-uri','ipfs','hash','cid']` → `'content'` else `'metadata'` (`s2s-records-tab.ts:117–123, 209–264`).
- A separate records store (the ENS records contract, C3) holds per-publication **text records**, not the module KV: `contenthash_wrapped` (INV-6) and `content_cache_<publication>` are read via `getText(node, key)` — `safe-app/src/components/s2s-website-tree-tab.ts:164–232`.

### Gotchas
- **There is no single canonical publication-side key list.** It is scattered across `new.ts`
  (name/config/repo/branch/feed), `config.ctrl.ts` (`config`), `website-tree-tab.ts` (`contenthash_wrapped`,
  `content_cache_<publication>` on the ENS contract). `SPEC-contracts-publication.md` states this
  explicitly: "Key set is INV-2 — the contract doesn't constrain keys, the readers do."
- The **`gateways` key is effectively dead** — it is mentioned in SPEC-safe-app's action table
  ("updating `config`/`name`/gateways changes what renders", `SPEC-safe-app.md:99`) but is not written
  by `new.ts` and not read by the render/update actions (only the controller's `data_gateway` is live).
- Adding a new record key (e.g. `bylines`, `manifest`, `backup_manifest`) is **fully supported by the
  contract** — it is just a new string key; the on-chain cost scales with the string length, so a
  large manifest is better stored off-chain with only a CID pointer on-chain (the `config`-record
  pattern).

---

## Q2. IPFS UPLOAD — code paths and pinning providers

### Short answer
Everything writes to one **Kubo node** (`https://ipfs.transport-union.dev`) via `/api/v0/*` HTTP
(`add`, `dag/put`, `dag/get`, `cat`, `files/*` MFS, `pin/add`). Pinning to an external provider has
been switched **from Pinata to Filebase** — Pinata calls are disabled/commented out. There is
**no "list everything pinned" capability anywhere**; the closest are Filecoin piece listing
(`listPublicationStorage`) and the on-chain `getDeals`. Pinning is **implicit on Kubo add** (the
node holds it) plus explicit `pin/add` at a few action sites and Filebase PSA re-pin for durability.

### Code paths
- `safe-app/src/lib/ipfs.factory.ts` — `fetchFromIPFS` (L3), `add` (L22, `api/v0/add`), `dagPut` (L48), `dagExport` (L90, `api/v0/dag/export` → CAR bytes for Filecoin), `fixEndpoint` (L118).
- `safe-app/src/lib/ipfs-fs.factory.ts` — `IPFS_URL = "https://ipfs.transport-union.dev"` (L3); MFS helpers `prepareTempMfs`, `kuboMfsList`, `kuboMfsStat`, `kuboMfsFlush`, `kuboMfsCp` (files/* endpoints) (L16–117).
- `shared/src/ipfs/index.ts` — `S2SIPFSMethods`: `addToKubo`, `dagPut`, `dagGet`, `fetchFromKubo`, MFS helpers (L150–420). Constructor `(kuboGateway, pinataJWT, pinataGateway, filebaseToken?)` (L24–31).
- `protocol/actions/src/libs/ipfs.factory.ts` — actions-side `uploadFile`, `catFile`, `getDag`, `putDag(… pin=true)` (L146), `createUnixFSFromCbor` with explicit `pin/add` (L248), `contenthashToIPFS`/`decodeArchiveCid`.
- `protocol/actions/src/update/main.ts:316` — `pin/add?arg=${newRootCid}` after each update.
- `cid-mirror/src/ipfs/kubo.ts` — read-only `KuboClient` (`catBytes`, `ls`, `dagGet`), mirrors S2SIPFSMethods.

### Pinning providers configured across the repo
| Provider | Status | Where |
|---|---|---|
| **Kubo** (`ipfs.transport-union.dev`) | active (implicit pin on add; explicit `pin/add`) | ipfs-fs.factory.ts:3; ipfs.factory.ts (actions):248; update/main.ts:316 |
| **Filebase** | **active** — `uploadToPinata()` actually POSTs to `rpc.filebase.io/api/v0/add` (Kubo-compatible, Bearer token) | shared/src/ipfs/index.ts:203–239 (renamed, uses `filebaseToken`) |
| **Filebase PSA re-pin** | active — `pinCidFromRemote` → `api.filebase.io/v1/ipfs/pins` | shared/src/pin/index.ts:11–51 |
| **Pinata** | **DISABLED** (commented out, "eth.link recommends Filebase") | shared/src/ipfs/index.ts (commented `uploadToPinata_pinata`, ~L241–270); shared/src/pin/index.ts (commented `pinCidFromRemote_pinata`); safe-app s2s-deals-tab.ts:314 (commented) |
| **Filecoin (on-chain durability)** | active, additive/non-blocking | `FilecoinStorage.uploadJson`/`uploadTree` (shared/src/filecoin/index.ts:329–431), used in s2s-records-tab.ts:336–388 |
| **0xobsidian (separate app)** | own `pinata.ctrlr.ts`/`pin.factory.ts`, dual Kubo+Filecoin | 0xobsidian/src/ipfs/* (not part of safe-app) |
| **Provider abstraction (typed only)** | `StorageCredential` union `pinata | filebase | filecoin-self | filecoin-session | kubo-only` — **no runtime selector**, code hardcodes Filebase | shared/src/protocol/types.ts:259–264 |

### Is there any way to list "everything currently pinned"?
**No.** There is no `pin/ls`, no PSA `GET /v1/ipfs/pins`, no `api/v0/pin/*` listing anywhere
(grep for `pin/ls`, `v1/ipfs/pins`, `GET.*pins`, `listPins`, `unpin` returns only `pin/add` call
sites). `S2SIPFSMethods.mfsList` only lists MFS dirs, not pins. Closest substitutes:
- **Filecoin pieces attributed to an identity/publication**: `FilecoinStorage.listPublicationStorage(attributedTo)` (shared/src/filecoin/index.ts:459–552) and `listStorageFor(identity)` (L564+) — used by safe-app (`s2s-app.ts:127`, storage tab). This lists Filecoin *pieces*, not IPFS pins.
- **On-chain deals**: `getDeals`/`getOffers` (publication module) — see Q5.
- **Live site tree**: `s2s-website-tree-tab.ts` walks the published DAG from the root CID (not pins).

### Gotchas
- The **"dual pin provider worktree"** concept is only the *typed* `StorageCredential` union and the
  disabled Pinata remnants — there is no runtime multi-provider pinning path today; Filebase is
  unconditional.
- `VITE_PINATA_JWT` is still passed in `makeIPFS()` (`s2s-records-tab.ts:198`) but is **unused** by
  the active Filebase path — vestigial.
- A backup manifest would have to record its own CIDs (there is no source of truth for "all pins").
  Building a "list everything pinned" feature means either adding a `pin/ls`/PSA-GET call or
  maintaining an explicit manifest (which is exactly your feature (1)).

---

## Q3. ENCRYPTION — what `LitService` (prod = Chipotle) actually exposes

### Short answer
`LitService` is a **thin REST client to Lit's Chipotle Core API** (`api.chipotle.litprotocol.com/core/v1`),
**not** the classic Lit SDK. It exposes a PKP-scoped `encrypt`/`decrypt` pair (plus PKP/group/usage-key
management and `executeAction`). There is **no authSig / no session-sigs** in the current flow — auth
is a plain `X-Api-Key` (account/usage key). **Access control is NOT encoded in the encrypt step**; it is
enforced at **decrypt time inside a Lit action** by an on-chain gate. There **is** an existing
client-side encryption pattern (`buildSignedContentItem(…, encryptFn, …)`), but the live authoring path
currently uses a **`noOpEncrypt` passthrough — content is published plaintext today**. Access control
can be scoped to **Safe-owner EOAs** (the signer must be an owner of the Safe, and the Safe must be
whitelisted / have a deal) — not to the Safe contract address alone (a Safe can't sign an ECDSA session).

### LitService API surface (shared/src/lit/lit.service.ts)
- Constructor `(config: { environment: 'dev'|'prod'; accountKey?: string })` — baseUrl = `api.dev.litprotocol.com/core/v1` / `api.chipotle.litprotocol.com/core/v1` (L16–26).
- `call(endpoint, {method, body, key, retries})` — REST with `X-Api-Key` (L54–130).
- Unauthenticated: `getChainConfig()`, `getActionCid(code)` (L133–158).
- Account-key management: `createPkp()`, `listPKPInGroup`, `listAllPKPs`, `createGroup`, `inspectGroup`, `registerAction(cid,name)→{hashedCid}`, `addActionToGroup`, `removeActionFromGroup`, `addPkpToGroup`, `createUsageKey`, `removeUsageKey` (L162–252).
- Execution: `executeAction(code, jsParams, key)` → `{response, logs, has_error}` (L256–276).
- **Encrypt**: `encrypt(key, pkpId, message) → ciphertext` — runs the `encryptAction` lit action
  (`Lit.Actions.Encrypt({ pkpId, message })`) (L281–318; action in shared/src/lit/actions/encrypt.ts).
- **Decrypt**: `decrypt(key, pkpId, ciphertext, userAddress, signature, action) → plaintext` — runs the
  passed `action` code (L320–347).

### Access-control model (the important part)
- The actual gate is a **Lit action** that first checks on-chain then calls `Lit.Actions.Decrypt`:
  `protocol/actions/src/libs/decrypt.ts` → `canRead(...)` then `Lit.Actions.Decrypt({pkpId, ciphertext})`.
- `canRead` — `protocol/actions/src/libs/gates.ts:10–40`:
  ```
  const genesis = toBytes32Id(contentId);
  const [cp, isOwner, isDeal] = Promise.all([
    evmRead(publicationModule, "canPublish", [safeAddress]),
    evmRead(safeAddress, "isOwner", [signerAddress]),
    evmRead(publicationModule, "hasDeal", [genesis]),
  ]);
  return cp && isOwner && isDeal;
  ```
  → the **Safe** must be whitelisted (`canPublish`), the **signer EOA** must be an owner of that Safe
  (`isOwner`), and the genesis must be a **live deal** (`hasDeal`).
- `canPublish` gate — `gates.ts:46–56`: `canPublish(authorSafe) && isOwner(authorSafe, signer)`.
- `canReset` — `gates.ts:74–84`: `isOwner(multisig, signer)` (publication-Safe owner only).
- **Signer is always an EOA wallet**: `safe-app/src/lib/safe-integration.ts:385` `signWithSigner`
  uses `new ethers.BrowserProvider(window.ethereum).getSigner().signMessage(message)`, called with
  `'lit actions auth'` (`s2s-deals-tab.ts:279`, `website-tree-tab.ts` reset).
- So: **scope = Safe-owner EOAs**, not the Safe address alone. This mirrors the contract's own
  `canPublish` note `// could be safe owners ???` (`S2SPublicationModuleV2.sol:280`) — a Safe *owner*
  EOA does not pass `canPublish` by itself.

### Is there any client-side encryption pattern in shared/safe-app?
- **Yes (machinery)**: `buildSignedContentItem(pub, body, signer, encryptFn, author?)`
  (shared/src/identity/sign-content.ts:54–89) — computes `plaintextHash`, EIP-712 `objectId`, signs,
  then `bodyContent = await encryptFn(bodyJson)`. `noOpEncrypt` passthrough (L109). `LitService.encrypt`
  is the natural `encryptFn`.
- **But the live path does NOT encrypt**: `neutralpress/src/content/content.ctrlr.ts:154–172` calls
  `buildSignedContentItem(..., signer, noOpEncrypt, toDidEthr(baseAccount.address))`. Content is
  **signed + stored plaintext**; `encryption` is a frontmatter flag defaulting false
  (content.ctrlr.ts:116). `shared/src/content/_vault.ts:85` shows a commented `encrypted: "{}"`.
- Decrypt at render time IS wired (render/main.ts:255–295, via `decrypt` → `canRead`).
- **No authSig/session-sigs** anywhere in shared/safe-app/actions (grep returns only the render
  "per-session HTTP budget" comments and Filecoin session keys — no Lit `createSessionSignatures`/
  `mintCapacityToken`). Those pre-Chipotle (Datil) helpers live only in the **legacy, now-external**
  website-starter `dev-assistant` and are slated for removal (SPEC-website-starter.md:59–60).

### Gotchas / implications for feature (1)
- **PKP-scoped, not ACC-scoped**: `encrypt` to a PKP is permitted to anyone holding the usage key;
  *restriction* happens at decrypt via the gate. For a **private backup manifest**, you would encrypt
  to the author's PKP and gate decrypt on `canRead`-style ownership (author Safe + owner EOA). This is
  exactly the model already used for encrypted publication content.
- Since the current publish path is plaintext (`noOpEncrypt`), a private manifest is a **new** use of
  the existing `encrypt`/gate machinery — nothing to reuse as a shipped encrypted artifact today.
- There is no way to scope decryption to the Safe contract address itself (no ECDSA signer); the
  decryptor must be an **owner EOA**.

---

## Q4. EXISTING "CATALOG/BACKUP" CONCEPTS

### Short answer
**No backup/restore of local works, no "my works" tab, no holdings/inventory store exist** in safe-app,
neutralpress, or website-starter. But several **partial / adjacent** concepts do exist, and the design
intent for a "curated catalog of works" is already captured in `brain/` (unimplemented):

- **Deals tab = a per-publication "works list" (read-only)**: lists all deals + offers with genesis/cid/
  author/timestamp — `safe-app/src/components/s2s-deals-tab.ts`; data from `getAllDealsAndOffers`
  (`safe-app/src/lib/safe-integration.ts:203–228`).
- **Website Tree tab = live content inventory**: walks the published DAG from the root CID, shows
  added/removed paths (`safe-app/src/components/s2s-website-tree-tab.ts`). Also reads `content_cache_<publication>`
  (a per-publication cache-CID pointer on the ENS records contract).
- **FilecoinStorage.listPublicationStorage / listStorageFor** = "what this identity holds" on **Filecoin**
  (not IPFS): `shared/src/filecoin/index.ts:459–552`, `564+`; used by safe-app (`s2s-app.ts:127`).
- **Local observable store** = `localStorage`-backed cache only (state/store.ts, record.store.ts,
  deal.store.ts, storage.ts) — not a durable/exportable manifest.
- **Per-render image manifest** (not a backup): `media: [{filename, cid}]` on `S2SJob`
  (brain/handoffs/handoff-author-images.md:123–227).
- **Author-owned byline record (THE closest precedent — unimplemented design)**: store a `bylines`
  record on an `S2SRecordsModule` deployed on the **author Safe** via `setRecord('bylines', <value>)`,
  verified against each publication's module via `authorOf(genesis)==authorSafe && hasDeal(genesis) &&
  getLatest(genesis)` — `brain/research/2026-09-10-author-owned-bylines-scoping.md` (§1, §2.4, §3.2). This
  is effectively your **feature (2)** at the on-chain layer. Zero new contract code needed.
- **`getBylines(author)` primitive (RFC, parked)**: cross-publication author view + right-to-be-forgotten
  `hiddenByAuthor[(publication,genesis)]` visibility filter — `brain/specs/RFC-protocol-wide-deals-ledger.md`
  (Required behavior §new-on-ledger; open confirmations 4). **Not implemented.**
- **Owner-history handoff explicitly names the concept**: "the author's records module (**curated catalog
  of works**)" is stated as distinct from owner-key history — `brain/handoffs/handoff-owner-history-module.md:27–31`.
- Related research (all read-only, none shipped): `2026-09-10-portable-byline-*.md`,
  `2026-09-10-protocol-wide-deals-contract.md`, `2026-09-10-external-indexer-trust-model.md`.

### Gotchas
- **safe-app has no local authoring storage** — the author's local works/CIDs live in neutralpress
  (Obsidian vault frontmatter, e.g. `genesis`, `author` fields in note frontmatter —
  content.ctrlr.ts:175–185) and 0xobsidian. A "private backup manifest of what the author holds
  locally" is more naturally produced by **neutralpress/0xobsidian**, not safe-app (safe-app runs inside
  the Safe wallet iframe and only sees on-chain + IPFS, not the local vault).
- The "curated" (public) half of your feature already has a strong, unimplemented design lineage
  (bylines + `getBylines` + right-to-be-forgotten). You'd be converging, not inventing.
- On-chain per-author enumeration **across publications** does not exist today (only per-module
  `getDeals`); that is the gap `getBylines` fills.

---

## Q5. ON-CHAIN ENUMERATION — exact shapes for JOINing a curated list

### Short answer
- `Entry { bytes32 genesis; address author; string cid; uint256 timestamp; }` — **genesis is `bytes32`**
  on-chain; **`cid` is the (encrypted) content CID string**; `author` is the **Safe address**
  (`genesisAuthor[genesis]`, immutable after first append).
- `getDeals(offset, limit) → Entry[]`, `getOffers(offset, limit) → Entry[]`, `getLatest(bytes32) → Entry`
  (single, reverts "no versions"), plus `getDealCount`/`getOfferCount`/`getVersion`/`getVersionCount`/
  `isGenesis`/`authorOf`.
- `toBytes32Id(ref)`: passthrough if already `0x`+64-hex, else `keccak256(utf8(ref))`. For neutralpress
  notes the **genesis IS the EIP-712 `objectId` digest** (a bytes32), **not** the CID — the CID is the
  `Entry.cid` field. So genesis and CID are two different values and must not be conflated.
- ABI is generated at `protocol/contracts/generated/abis/S2SPublicationModuleV2.ts` (Entry components
  ~L402–455).

### Evidence
- `protocol/contracts/contracts/S2SPublicationModuleV2.sol`
  - `struct Version { string cid; uint256 timestamp; bool tombstone; }` (L41–45); `tombstone` always `false` (dead).
  - `struct Entry { bytes32 genesis; address author; string cid; uint256 timestamp; }` (L46–49).
  - `getDeals`/`getOffers` (L217, L221); `getDealCount`/`getOfferCount` (L225–226); `getLatest` (L250); `getVersion`/`getVersionCount` (L261, L266); `isGenesis` (L270); `authorOf` (L274).
  - `_page` assembles each `Entry` from `versions[g][latestIndex[g]]` + `genesisAuthor[g]` (L233–247) — **a read-return struct, not a stored array**.
  - `dealAt`/`offerAt` are **write-only**, deleted on removal, no getter (L69/74/375/389/396/410) — deal **start time is not on-chain readable**.
- `toBytes32Id` — `shared/src/identity/contract-id.ts`: `HEX32_RE = /^0x[0-9a-fA-F]{64}$/`; passthrough, else `keccak256(toUtf8Bytes(trimmed))`.
- Genesis = objectId: `neutralpress/src/publication/publish.ts:71` ("genesis = signedItem.objectId (first version IS the genesis for a new note)"); `neutralpress/src/content/content.ctrlr.ts:175–185` (genesis read from frontmatter, preserved on updates).
- safe-app wrapper: `getDeals`/`getOffers`/`getAllDealsAndOffers` (safe-integration.ts:178–228) → `{genesis: string(bytes32 hex), author, cid, timestamp: bigint, status}`.
- Independently confirmed by `brain/research/2026-09-10-genesis-deal-surface-confirmation.md` (Q2 table, Q3: dealAt write-only; start/end reconstructable off-chain from `DealStruck`/`OfferAccepted`/`Retracted` block timestamps).

### Gotchas / JOIN implications
- **Genesis is bytes32, not a string CID.** A curated public list keyed on genesis should store the
  `0x…` bytes32 (author-visible via the safe-app deals list) and separately the `cid`. `toBytes32Id`
  makes a raw CID→genesis not invertible (keccak) — so a manifest that needs to *recover the CID from
  the genesis* must store both (the on-chain `Entry.cid` is the source for the latest CID).
- **Per-module only**: `getDeals` is per-publication-module. An author in N publications needs N module
  reads (or the parked `getBylines`). `Entry.author` (Safe) is the stable join key across modules.
- `dealAt` not exposed → no on-chain deal-start; use events/block timestamps if you need `start`.

---

## Q6. RENDER SURFACE — where a curated public list could plug in

### Short answer
- **`website-starter/` in this monorepo is EMPTY** (only `node_modules`) — it was `git subtree split`
  into its own repo `github.com/Joera/website-starter` and removed from the workspace
  (SPEC-website-starter.md:1–6). Do not expect starter code here.
- The real renderer lives in **`protocol/actions/src/renderer/`** (html.ctrlr, handlebars.factory,
  handlebars-helpers, template) driven by `render/main.ts`. It renders a **single publication's**
  `home`/`page`/`post` templates.
- **`mapping.json` schema** = `{ templateConfig: S2STemplateConfig[], ripples: S2SRipple[] }`
  (`shared/src/protocol/types.ts:206–209`; `shared/src/publication/types.ts:11–13, 23–35`).
  `templateConfig[]` entries have `{reference, file, path, collections?}`; collections feed templates
  via `{{#each collections.<slug>}}` (SPEC-website-starter.md:49). `ripples` define cascade destinations.
- **There is NO index/catalog/publications-list surface today.** The site is one publication's pages;
  there is no "list of publications" template, no feed-rendering page. `feedAddress` and page `postId`
  are **Lens-legacy** values carried in the author's `mapping.json` (in the external repo) and used for
  ripples/collections referencing Lens — **not part of the typed schema here** and not rendered into a
  catalog.
- `ConfigBuilder` fetches `mapping.json` **verbatim** from GitHub and `JSON.parse`s it, injecting only
  `localePaths` — it does **not** inject `feedAddress` (`shared/src/publication/config-builder.ts:192–216`).

### Evidence
- Empty dir: `website-starter/` has only `node_modules`.
- Renderer: `protocol/actions/src/renderer/{html.ctrlr,handlebars.factory,handlebars-helpers,template}.ts`;
  orchestration `render/main.ts` (`renderHTML` at L305, collections fetch at L236).
- mapping schema: `shared/src/protocol/types.ts:190–209` (`S2SCollection`, `S2SRipple`, `S2STemplateConfig`, `IMapping`); `shared/src/publication/types.ts:23–35` (`S2SPublicationConfig.mapping: S2SMapping`).
- Handlebars helpers (renderer): `unique_years`, `filter_by_year`, `formatDate`, `formatDateAsMonthYear`, `limit`, `explode`, `indexEqualsZero`, etc. — **no `authorFromAddress`** (protocol/actions/src/renderer/handlebars-helpers.ts:97–556).
- ConfigBuilder verbatim mapping + `localePaths` injection: `config-builder.ts:194–216`.

### Gotchas / where a curated list would plug in
- Because templates are Handlebars over a `templateData` object (`render/main.ts` builds `templateData`
  with `collections`, `publications`, `content`), a curated public list could be injected as a **new
  data source** (e.g., a render-time fetch of the author's `getDeals`/`authorOf`/byline record → a
  `collections`-style array) and rendered by a new template + `templateConfig` entry. There is no
  existing list surface to reuse; you'd add one.
- Any on-chain → render list feature must go through the **render/update Lit-action pipeline** (the
  templates only render what the action supplies in `templateData`), not the static starter.
- `feedAddress`/`postId` in the author's `mapping.json` are the documented "onboarding sharp edge"
  (SPEC-safe-app.md gotchas, first bullet; DECISION TODO to have ConfigBuilder inject `feedAddress`).

---

## Spec cross-checks — contradictions / drift vs the docs you cited

1. **Tab count — SPEC-safe-app says 4, code has 5.** `SPEC-safe-app.md:22` "4 tabs
   (Deals/Records/Storage/Whitelists)" and the sub-component map omit the Website Tree tab; code defines
   **5** tabs (`Deals, Whitelist, Records, Storage, Website Tree`) — `s2s-app.ts:34, 168`, imports at
   `s2s-app.ts:3–7`; the tab is real (handoff-website-tree-tab.md exists). *Stale spec.*
2. **Pinning: specs imply Pinata, code is Filebase.** `SPEC-safe-app.md:24` "Boundary interfaces …
   consumes … GitHub API + **Pinata + Kubo**" and `SPEC-00 §3.2` treat Pinata as primary. Code has
   **disabled Pinata in favor of Filebase** (shared/src/ipfs/index.ts, shared/src/pin/index.ts). *Doc
   not updated for the Filebase switch.*
3. **`authorFromAddress` helper doesn't exist in the renderer.** `SPEC-website-starter.md:53` lists it;
   `protocol/actions/src/renderer/handlebars-helpers.ts` has `formatDate` but no `authorFromAddress`.
   (Starter lives in its own repo, so this may be drift between the renderer copy and the starter.)
4. **`gateways` key is nominal.** `SPEC-safe-app.md:99` says updating "`config`/`name`/gateways changes
   what renders"; no code writes or reads a publication `gateways` record (only controller `data_gateway`).
5. **INV-2 protocol key list is consistent** between `SPEC-00:208`, `shared/src/protocol/index.ts:12–28`,
   and `protocol/actions/src/libs/protocol.factory.ts:20` (incl. the dropped `pkp_tokenId`/`pkp_publicKey`
   — GAP-11, consistent).
6. **RFC-cid-mirror.md** is consistent with code: records discovery decodes `getRecords` as `string[]`
   with `ens_records` at index 1 (matches `S2SRecordsModule.getRecords`); the vendored contenthash copy
   exists at `cid-mirror/src/ipfs/contenthash.ts`. (RFC's "PR #80 not in main" caveat predates this HEAD;
   cid-mirror/src is present.)
7. **Genesis vs CID** — none of the specs you cited state it as bluntly as the code: on-chain genesis is
   `bytes32`, and for neutralpress notes it **equals the EIP-712 objectId digest, not the CID**. Any
   manifest must keep genesis and cid as distinct fields (both are needed for restore + for on-chain
   JOIN).
8. **No backup/restore anywhere** — consistent with all three specs (none claim one). The "curated catalog
   of works" is named only in `handoff-owner-history-module.md:27–31` and designed (unimplemented) in the
   bylines research/RFC.

---

## Bottom line for your design question

- **On-chain = mapping only is sufficient** for a *pointer* to a private manifest and for the *public
  curated list*: store a CID under a new record key (e.g. `bylines`/`manifest`) in an `S2SRecordsModule`
  (author Safe for the private manifest; publication Safe for the public list) — the `config`-record
  precedent. The contract places no size/format constraint and supports arbitrary new keys.
- **Push manifests to IPFS too**, because the on-chain record can only hold a pointer, and the closest
  thing to a durable pin is Filebase/Kubo — but note **there is no "list my pins" primitive** to recover
  a manifest after loss, so the manifest must be *self-describing* (an explicit list of every
  genesis→cid the author holds) rather than derived from pins. Pinning today = Kubo implicit pin +
  Filebase PSA re-pin (`pinCidFromRemote`); that is the mechanism to keep the manifest alive.
- **Encryption for a private manifest**: reuse the PKP-scoped `LitService.encrypt` + the `canRead`-style
  gate (author Safe + owner-EOA `isOwner` + deal) — but this path is currently exercised only at render
  decrypt, and the authoring side currently uses `noOpEncrypt` (plaintext). A private manifest is a
  **new** consumer of existing (unused-in-authoring) encryption machinery.
