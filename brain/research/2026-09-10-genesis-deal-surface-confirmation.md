# Findings — Genesis / Deal Read-Surface Confirmation for the Portable Byline

> **Scope:** read-only research. No code changed, no PR. Two confirmation questions for the
> s2s publishing protocol, answered precisely against code. This is **research**, not a
> SPEC/RFC (no settled behavior is claimed) — follows `docs-conventions.md`.
>
> Date: 2026-09-11. Workspace: `/home/joera/code/s2s`. Brain: `/home/joera/code/s2s/brain`.
>
> **Purpose:** before finalizing the author-owned byline schema `{item, publication, start, end}`
> (author Safe + `S2SRecordsModule` store, claims verified against each publication's own module),
> pin down three facts against the current contracts/specs: (1) identity/ownership model,
> (2) the per-genesis read surface of the publication module (V2 + V1), (3) deal timestamps and
> whether an ended deal is reconstructable off-chain.

---

## Q1 — Identity / Ownership Model

### Q1(a) The Safe is a contract wallet whose owners are EOAs; owner keys rotate, the Safe address stays stable — CONFIRMED

- **Safe construction = SafeL2 v1.4.1 proxy whose owner is an EOA signer, threshold 1.**
  `0xobsidian/src/eth/permissionless.safe.service.ts`:
  - `connectToFreshSafe` (L170–185): `toSafeSmartAccount({ owners: [this.signer], threshold: 1n,
    version: "1.4.1", safeSingletonAddress: SafeL2 v1.4.1 on Base, saltNonce })`. `this.signer` is
    an **EOA** created in `updateSigner(pk)` (L108–110) via `privateKeyToAccount(pk)`.
  - The address is deterministic from the EOA: `main.ctrlr.ts initChain` (L146–158) derives
    `salt = \`s2s_${this.user.eoa}\`` then `connectToFreshSafe(salt)` (new author) or
    `connectToExistingSafe(this.user.safe)` (existing author).
- **Owners rotate while the Safe address stays stable.** `updateSigner(pk)` swaps the EOA; the
  subsequent `connectToExistingSafe(safe_address)` (L186–204) reconnects to the **same** Safe
  address with the new signer. The Safe's owner set is managed via the standard Safe functions
  `addOwnerWithThreshold` / `removeOwner` / `swapOwner` / `changeThreshold` / `isOwner` /
  `getOwners` (`0xobsidian/src/eth/safe_implementation.abi.ts`,
  `shared/src/contracts/safe_implementation.ts`); `newPublicationSafe` batches
  `addOwnerWithThreshold` per owner (`shared/src/publication/new.test.ts` L306–325).
- **Spec/whitepaper state it explicitly:** SUMMARY-protocol §1 (L33) "Key rotation = swap the
  Safe's signers"; whitepaper `00-introduction.md` L58–62 "Key rotation = **swap the Safe's
  signers**, not the DID"; `01-content-authoring.md` L60–95 "Practical rule: rotate signers, not
  the DID."

### Q1(b) Protocol author identity = `did:ethr:<safe_address>` — the DID names the SAFE, never the rotating EOA — CONFIRMED

- **`DidEthr` type + helpers** (`shared/src/protocol/types.ts`): `DidEthr = \`did:ethr:0x${string}\``
  (L37), `toDidEthr(address)` (L112), `eoaOf(did)` (L117) — `eoaOf` merely strips the `did:ethr:`
  prefix; the address it carries is the **Safe**.
- **On-chain identity is the address, and it is the Safe address.**
  - SPEC-00 **INV-append** (L207): "On-chain identity is an `address` (`genesisAuthor[genesis]`,
    set by the first `canPublish` caller) … `did:ethr` is the **client-side** identity layer
    (`shared/src/identity`) that resolves to this address; the contract stores no did."
  - `S2SPublicationModuleV2._append` (L347–360) sets `genesisAuthor[genesis] = author`, and
    `makeOffer(genesis,cid)` passes `author = msg.sender` (L169). Because the author publishes
    through its **4337 Safe**, `msg.sender` **is the Safe** (see below).
  - `Entry.author` (V2 L48) is filled from `genesisAuthor` (`_page` L243, `getLatest` L255) → the
    Safe address.
- **Where the author is stored:**
  - `Entry.author` (read-return struct, V2 L48) = Safe address.
  - `genesisAuthor[genesis]` (V2 L59) = Safe address; **immutable** after first append (INV-append).
  - `S2SRecordsModule.sol` — `safe` is an **immutable** constructor arg (L~); it is the author's
    own store (author Safe as `safe`). Not an author-identity record today; it is the byline home.
  - No author stored as a did string anywhere on-chain (confirmed: **no** `did:ethr`,
    `EthereumDIDRegistry`, or `did:safe` in any `.sol`).
- **How 4337/Safe makes `msg.sender == Safe`:** all author writes run through the permissionless
  4337 Safe account (`toSafeSmartAccount` + Pimlico bundler/paymaster,
  `permissionless.safe.service.ts`), so `msg.sender` is the Safe; the contract's `onlySafe`
  modifiers check `msg.sender == safe` (V2 L91–93; RecordsModule). The on-chain caller recorded by
  `_append` is the Safe. Grounded in `neutralpress/src/content/content.ctrlr.ts` L177 comment:
  "Author is the Safe address (on-chain msg.sender). The EOA that signs is a Safe owner, verified
  off-chain." → `toDidEthr(baseAccount.address)`.
- **The EOA is the signer gate, never the identity.** `protocol/actions/src/libs/gates.ts`:
  `canPublish` (L46–56) recovers the EOA from the `"lit actions auth"` sig and checks
  `authorSafe.isOwner(signerAddress)`; `canRead` (L20–36) also requires `hasDeal`. The contract
  itself never sees the EOA as author — `canPublish`'s `// could be safe owners ???` (V2 L280)
  confirms a Safe *owner EOA* does **not** pass.

### Does ANY place name the EOA instead of the Safe? — One, and it is a documented provenance inconsistency, not the author identity

- `protocol/actions/src/render/main.ts` L320 builds **`publisher.did`** from `signerAddress`
  (the recovered EOA): `did: signerAddress ? \`did:ethr:0x${signerAddress…}\` : ''`. The **author**
  did (`body.author`, from `S2SPublicContent.author`) is the **Safe**. This is the divergence
  already flagged by `2026-09-10-portable-byline-convergence.md` §4-gaps: "render/main.ts builds
  the *publisher* did from the EOA (`signerAddress`) while the *author* did is the Safe."
- `S2SProof.signer` (`types.ts` L58–61) is the EOA — by design (the EOA signs the EIP-712 digest;
  the Safe owns it). Not an identity string.

### What does the spec say `did:ethr` resolves to?

- There is **no DID document, no resolver, no Veramo, no `EthereumDIDRegistry`** in code or specs.
  `did:ethr` is a **client-side string convention** for the Safe address (SPEC-00 INV-append;
  whitepaper `01-content-authoring.md` L62–66: "standard `did:ethr`, pointed at a Safe address…
  no `did:safe` method — shorthand for did:ethr-over-Safe").

### Q1 VERDICT

**`did:ethr:<safe_address>` HOLDS as the byline's identity string.** The DID names the **Safe
address** (a stable contract wallet), never the rotating EOA owner/signer. Grounding:
`S2SPublicationModuleV2._append`/`genesisAuthor`/`Entry.author` (V2 L48/L59/L347), `S2SRecordsModule`
immutable `safe`, `permissionless.safe.service.ts` `toSafeSmartAccount` + `updateSigner` +
`connectToExistingSafe`, `gates.ts` EOA-isOwner, `content.ctrlr.ts` L177, SPEC-00 INV-append,
SUMMARY-protocol §1, whitepaper 00/01. The only EOA-name in the system is the *publisher*
provenance field (render/main.ts L320) and `S2SProof.signer` — neither is the author identity.

---

## Q2 — Per-genesis read surface in the publication module

All line numbers cite `protocol/contracts/contracts/S2SPublicationModuleV2.sol` (V2) and
`S2SPublicationModule.sol` (V1).

### V2 — `S2SPublicationModuleV2` (current, UUPS per-publication proxy), genesis = `bytes32`

Per-genesis getters:

| fn | returns | exact fields / notes | line |
|---|---|---|---|
| `hasDeal(genesis)` | `bool` | `_isDeal[genesis]` — the Lit gate read | 207 |
| `hasOffer(genesis)` | `bool` | `_isOffer[genesis]` | 211 |
| `getLatest(genesis)` | `Entry` | **reverts** `"no versions"` if none. `Entry{bytes32 genesis; address author; string cid; uint256 timestamp}`. author = `genesisAuthor[genesis]` (Safe); cid = latest version's cid; timestamp = latest version's append `block.timestamp`. **No tombstone, no publication, no start/end in Entry.** | 250 |
| `getVersion(genesis, index)` | `Version` | `Version{string cid; uint256 timestamp; bool tombstone}`. Reverts `"index out of bounds"`. `tombstone` always `false` (dead storage). | 261 |
| `getVersionCount(genesis)` | `uint256` | `versions[genesis].length` | 266 |
| `isGenesis(genesis)` | `bool` | `genesisAuthor[genesis] != address(0)` | 270 |
| `authorOf(genesis)` | `address` | `genesisAuthor[genesis]` = the **Safe address**. **IMMUTABLE** (set once on first append, INV-append). | 274 |

Set-level enumeration getters (page the deal/offer **sets**, not a global log; return `Entry[]`):

| fn | returns | notes | line |
|---|---|---|---|
| `getDeals(offset, limit)` | `Entry[]` | pages `dealList`, each entry's latest version | 217 |
| `getOffers(offset, limit)` | `Entry[]` | pages `offerList` | 221 |
| `getDealCount()` | `uint256` | `dealList.length` | 225 |
| `getOfferCount()` | `uint256` | `offerList.length` | 226 |

Permission / config getters:

| fn | returns | line |
|---|---|---|
| `canPublish(address)` | `bool` (safe ∨ whitelisted dev ∨ whitelisted author) | 280 |
| `isWhitelistedAuthor(address)` | `bool` | 287 |
| `isWhitelistedDev(address)` | `bool` | 291 |
| `getWhitelistedAuthors()` | `address[]` | 337 |
| `getWhitelistedDevs()` | `address[]` | 341 |
| `safe` (public var) | `address` | 20 |
| `NAME()` | `string "S2S Publication Module V2"` | — |

**Not exposed per-genesis (important for the byline):** there is **no getter** for `dealAt`,
`offerAt`, `dealPos`, `offerPos`, or direct `_isDeal`/`_isOffer` (only the `hasDeal`/`hasOffer`
booleans). `Entry` has **no `tombstone`** field. No publication-scope field (the module instance is
the publication). No `start`/`end` timestamps. `tombstone` is only surfaced inside `getVersion` and
is always `false`.

### V1 — `S2SPublicationModule` (deprecated, still accepted for discovery), keyed by `string content_id` — NOT `bytes32 genesis`

V1 has **no per-genesis deal/version log** and no deal/offer sets. Its read surface (all keyed by
`string content_id`):

| fn | returns | line |
|---|---|---|
| `isLicensed(content_id)` | `bool` | 262 |
| `isLicensedBulk(string[])` | `bool[]` | 266 |
| `getLicenseAuthor(content_id)` | `address` | 274 |
| `getAllContentIds()` | `string[]` | 278 |
| `getContentIds(offset, limit)` | `string[]` | 282 |
| `getContentIdCount()` | `uint256` | 300 |
| `hasPendingLicense(content_id)` | `bool` | 304 |
| `getPendingLicense(content_id)` | `(address author, address publication, uint256 timestamp)` | 308 |
| `canPublish` / `isWhitelistedAuthor` / `isWhitelistedDev` / `getWhitelistedAuthors` / `getWhitelistedDevs` | as V2 | 245+ |

**Key difference:** V1 exposes **no** `authorOf(genesis)`-equivalent immutable author map and **no**
`hasDeal`/`getLatest` per-genesis surface. The V1→V2 migration table
(SPEC-contracts-publication) maps `isLicensed→hasDeal`, `getLicenseAuthor→authorOf`/`Entry.author`,
etc. The byline's verification reads (`authorOf`, `hasDeal`, `getLatest`) are **V2-only**.

---

## Q3 — Deal timestamps / ended deals

### Where `dealAt` / `offerAt` are stored — write-only, no getter, deleted on removal

- `dealAt[genesis]` (V2 L69) and `offerAt[genesis]` (V2 L74) are private mappings, written by
  `_addDeal` (L375 `dealAt[g] = block.timestamp`) and `_addOffer` (L396 `offerAt[g] =
  block.timestamp`).
- **No view function exposes them.** Grep of the contract confirms the only references are the
  private mappings, the `_add*` writes, and the `_remove*` deletes. So the deal-start time is
  **not on-chain readable** via any getter today.
- On removal, the timestamp is **deleted, not tombstoned**: `_removeDeal` (L378–390) does
  `delete dealAt[g]` (L389) and `_removeOffer` (L399–411) does `delete offerAt[g]` (L410).

### State changes when a deal is retracted/ended (`retract`, L152–185)

- **Author retract** (`msg.sender == genesisAuthor`): `_removeDeal` (if deal) + `_removeOffer`
  (if offer) → **full withdrawal**; emits `Retracted(genesis, msg.sender, false)`.
- **Safe retract on a deal**: `_removeDeal` + `_addOffer` → **demotes deal → offer**; emits
  `Retracted(genesis, msg.sender, true)` (keptAsOffer = true).
- **Safe retract on an offer**: `_removeOffer`; emits `Retracted(genesis, msg.sender, false)`.
- **No tombstone flag on retract.** `Version.tombstone` (L44) is dead storage — `_append` always
  pushes `tombstone: false` (L362), and `retract` never sets it. The ended-deal signal is the
  removal from `_isDeal` + the `Retracted` event, not a tombstone.

### Event fields (timestamps NOT in the events)

| event | fields | line |
|---|---|---|
| `DealStruck` | `(bytes32 indexed genesis, address indexed author)` — **no timestamp** | 81 |
| `OfferAccepted` | `(bytes32 indexed genesis, address indexed author)` — **no timestamp** | 80 |
| `Retracted` | `(bytes32 indexed genesis, address indexed by, bool keptAsOffer)` — **no timestamp** | 82 |

### Can an off-chain reader reconstruct `{start, end}` per deal from events + getters alone?

- **YES — from events + block timestamps (an indexer), with NO new getter or slot required:**
  - `start` = `block.timestamp` of the block in which the deal-start event was mined
    (`DealStruck` on `makeOffer`; `OfferAccepted` on re-acceptance). This equals `dealAt` at that
    moment (both set in the same tx via `_addDeal`).
  - `end` = `block.timestamp` of the block in which `Retracted(genesis, …)` was mined.
- **Caveats / gaps for on-chain self-sufficiency:**
  1. **`dealAt` is write-only** — a getter alone (`hasDeal`) yields only the boolean; the time is
     available only from event logs + block timestamps (an indexer must store historical logs +
     block timestamps).
  2. `dealAt` is **deleted on removal**, so even the ended deal's start leaves no on-chain residual.
  3. `Retracted` has no timestamp → `end` always requires the block timestamp of the log.
  4. **Re-acceptance nuance:** after a safe-demote (deal→offer) then `acceptOffer`, `_addDeal` sets
     a **fresh** `dealAt` and emits `OfferAccepted` (not `DealStruck`). A reader reconstructing the
     *current* start must treat **both** `DealStruck` and `OfferAccepted` as deal-start events;
     using only `DealStruck` gives the original (possibly stale) start.
- **Conclusion:** the byline's `{start, end}` can be derived **off-chain from events + block
  timestamps** with zero contract change. A new getter/slot is needed **only** if the byline
  (`getBylines`-style) must be on-chain self-sufficient: expose `dealAt` and add a
  `retractedAt[genesis] = block.timestamp` slot (mirrors `deals-ledger-convergence.md` §6c
  recommendation: "derive off-chain from `Retracted` events; add the slot only if on-chain
  self-sufficiency is required").

---

## Summary table for the byline schema `{item, publication, start, end}`

| schema field | on-chain source today | reconstructable off-chain? |
|---|---|---|
| `item` (genesis, bytes32) | `genesis` in `Entry` / `getDeals` / `hasDeal` / `getLatest` | yes (contract read) |
| `publication` | implicit in the per-module instance (no field); author byline stores it as a label | yes — byline key/claim, verified by resolving that pub's module |
| `start` | `dealAt` — write-only, deleted on retract | yes — `DealStruck`/`OfferAccepted` block timestamp (indexer) |
| `end` | **no on-chain record** (Retracted carries no ts; `dealAt` deleted) | yes — `Retracted` block timestamp (indexer); else add `retractedAt` slot |

---

## Grounding files

**Contracts (`protocol/contracts/contracts/`):** `S2SPublicationModuleV2.sol` (makeOffer L169,
_append L347, genesisAuthor L59/L355, authorOf L274, hasDeal L207, getLatest L250, getVersion L261,
Entry L48, Version L41, dealAt L69/375/389, offerAt L74/396/410, _addDeal/_removeDeal L371/378,
_addOffer/_removeOffer L392/399, retract L152, events L80–82, canPublish L280, NAME L~);
`S2SPublicationModule.sol` (V1, string-keyed reads L245–311); `S2SRecordsModule.sol` (immutable
`safe`, onlySafe KV, NAME "S2S Records Module").

**App/Safe/4337:** `0xobsidian/src/eth/permissionless.safe.service.ts` (toSafeSmartAccount L172–177,
updateSigner L108, connectToExistingSafe L186); `0xobsidian/src/main.ctrlr.ts` (initChain L146–158,
salt `s2s_${eoa}`); `0xobsidian/src/eth/safe_implementation.abi.ts` + `shared/src/contracts/
safe_implementation.ts` (owner mgmt ABI); `neutralpress/src/content/content.ctrlr.ts` L177
(author = Safe); `protocol/actions/src/libs/gates.ts` (EOA-isOwner gate L20–56);
`protocol/actions/src/render/main.ts` L320 (publisher did = EOA).

**Shared:** `shared/src/protocol/types.ts` (DidEthr L37, toDidEthr L112, eoaOf L117, S2SProof.signer
L58); `shared/src/identity/sign-content.ts` (author default toDidEthr(signer), L59);
`shared/src/publication/new.ts` (module install / addOwner template).

**Specs / research:** SPEC-00-system-contract.md (INV-append L207, INV-3 L209, INV-10 L216, GAP-1
L227); SPEC-contracts-publication.md (C1 read/write API, permissions matrix, V1→V2 table);
SPEC-contracts-ens.md (C3/C4/C5, INV-12); SUMMARY-protocol.md §1 (L33); whitepaper
`00-introduction.md` L58–62 and `01-content-authoring.md` L60–95 (did:ethr-over-Safe, rotate
signers not DID); `2026-09-10-portable-byline-convergence.md`,
`2026-09-10-deals-ledger-convergence.md` (§6c: start=dealAt, end from Retracted events; add
`retractedAt` slot only for on-chain self-sufficiency), `2026-09-10-author-owned-bylines-scoping.md`
(§3.2 verification reads: `authorOf`/`hasDeal`/`getLatest`; §6 end from Retracted events).
