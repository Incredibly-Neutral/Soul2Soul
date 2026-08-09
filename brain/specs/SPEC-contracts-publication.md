# SPEC-contracts-publication

> **Audited against live code:** 2026-08-03.
>
> Per-publication on-chain layer: the two Safe modules. Read **SPEC-00** first. Sibling:
> **SPEC-contracts-ens** (the protocol-wide naming/resolution layer). Pairs with
> **SPEC-protocol-actions** (the actions gate against these modules). Follows SPEC-00 §7.
>
> C1 is `S2SPublicationModuleV2` (replaces V1 `S2SPublicationModule`). See §V2 migration below.

## V2 migration (from V1 `S2SPublicationModule`)

| V1 (deprecated) | V2 (current) | Notes |
|---|---|---|
| `grantLicense(pub, content_id)` | `makeOffer(genesis, cid)` | single author write; whitelist → deal, else → offer |
| `acceptLicense(content_id)` | `acceptOffer(genesis)` | onlySafe |
| `revokeLicense(content_id)` | `retract(genesis)` | asymmetric: author = full withdraw; safe = demote deal→offer or reject offer |
| `isLicensed(string)` | `hasDeal(bytes32)` | the Lit gate read |
| `isLicensedBulk(string[])` | — | replaced by `getDeals(offset, limit)` enumeration |
| `getAllContentIds()` | `getDeals(offset, limit)` | returns `Entry[]` structs, not id arrays |
| `getLicenseAuthor(string)` | `authorOf(bytes32)` / `Entry.author` | author in every Entry |
| `hasPendingLicense(string)` | `hasOffer(bytes32)` | |
| `getPendingLicense(string)` | `getOffers(offset, limit)` | returns `Entry[]` structs |
| `append(genesis, objectId, cid)` | `makeOffer(genesis, cid)` | objectId dropped; whitelisted → appends immediately as deal |
| `NAME() == "S2S Publication Module"` | `NAME() == "S2S Publication Module V2"` | module discovery string changed |
>
> Invariants carried: INV-3 (storage layout), INV-4 (module discovery), INV-10 (write auth),
> and INV-2 (record-key set, via the records module).

## Responsibility

Owns one publication's **permission state** (who may publish, what content is licensed) and its
**config** (KV records the actions read). Deployed **per publication** via factories; both are
**Safe modules on Base**, attached to that publication's Safe. Does not own naming, the site-root
pointer, or resolution — that is SPEC-contracts-ens.

## Interface to the ENS layer (the coupling any separation must preserve)

1. The records module (C2) stores **`ens_records`** = the address of the L2 ENS records contract
   the actions write the site root to (lives in SPEC-contracts-ens C3).
2. The actions' PKP must be `authorizedCaller` on that ENS records contract (**INV-12**) — granted
   by `update-protocol.ts`, not by these modules.
3. Shared conventions: `node = namehash(publication)`, the `contenthash_wrapped` key (INV-6).

---

### C1 — `S2SPublicationModuleV2` (UUPS upgradeable proxy)

**State (INV-3 — append-only, DO NOT REORDER existing storage slots):** in declaration order — `safe` (address); `versions` (`mapping(bytes32 genesis => Version[])`, `Version { string cid; uint256 timestamp; bool tombstone }`); `genesisAuthor` (`genesis => address`); `latestIndex` (`genesis => uint256`); `whitelisted_authors[]`, `whitelisted_devs[]` (caps 100/20); deal set `_isDeal` / `dealList` / `dealPos` / `dealAt`; offer set `_isOffer` / `offerList` / `offerPos` / `offerAt`. `Entry { genesis, author, cid, timestamp }` is a **read-return struct only** (assembled by `getDeals` / `getOffers` / `getLatest` from `versions[genesis][latestIndex]` + `genesisAuthor`), **not a stored array** — there is no `entries[]`.

**Write API + access control (precise — refines INV-10):**

| fn | who | effect |
|---|---|---|
| `whitelistAuthor/removeWhitelistedAuthor` | `onlySafe` | manage author whitelist |
| `whitelistDev/removeWhitelistedDev` | `onlySafe` | manage dev whitelist |
| `makeOffer(genesis, cid)` | **anyone** | whitelisted/safe → appends immediately as **deal**; else → appends as **pending offer** |
| `acceptOffer(genesis)` | `onlySafe` | promotes a pending offer → deal |
| `retract(genesis)` | **safe ∨ genesisAuthor** | asymmetric: the genesis author withdraws fully (deals + offers); safe demotes deal→offer or rejects an offer |
| `_authorizeUpgrade` | `onlySafe` | UUPS upgrade |

**Read API (the gate the actions depend on):** `canPublish(addr)` → safe ∨ whitelisted dev ∨ whitelisted author; `hasDeal(genesis)` → bool; `hasOffer(genesis)` → bool; `getDeals(offset, limit)` → `Entry[]`; `getOffers(offset, limit)` → `Entry[]`; `authorOf(genesis)` → address. These back `canPublish`/`canRead` in `libs/gates.ts`.

**Key contract:** content identifiers are `bytes32` on-chain. Off-chain code (neutralpress, safe-app, Lit actions) passes string CIDs/genesis refs and converts via `toBytes32Id(ref)` — keccak256 of anything not already a `0x`+64-hex string, passthrough otherwise.

**NAME():** `"S2S Publication Module V2"` (was `"S2S Publication Module"` in V1 — both accepted for backwards-compatible discovery).

**Gotchas:** `canPublish` has `// could be safe owners ???` — it checks the Safe *address*, so a Safe *owner* EOA does **not** pass; unresolved design Q. Whitelist removal ⇏ offer/retract. Factory deploys an `ERC1967Proxy` per Safe; `deployNewImplementation` retains version history. The old V1 license-state storage is gone — replaced by a **per-genesis** append log (`versions[genesis][]`) with a cached `latestIndex`, plus enumerable deal/offer sets (`dealList` / `offerList`) of genesis pointers. `(offset, limit)` paginates the deal/offer **sets**, not a global log; there is no single linear `entries[]` array.

### C2 — `S2SRecordsModule` (immutable; `NAME="S2S Records Module"`, `VERSION="1.1.0"`)

KV `string→string`; `safe` immutable; **all writes `onlySafe`** (`setRecord(s)`, `deleteRecord`);
reads `getRecord(s)` + enumeration. Used **twice** in the system: protocol config (controller Safe)
and publication config (publication Safe). Key set is INV-2 — the contract doesn't constrain keys,
the readers do (`getProtocolInfo` / `getConfig`).

**Gotchas:** immutable → not upgradeable (GAP-7 asymmetry vs C1). Enabled as a Safe *module* purely
for discovery (`getModulesPaginated`, INV-4); functionally the Safe calls *into* it.
**GAP-11:** the `pkp_tokenId` / `pkp_publicKey` keys are vestigial (pre-Chipotle); only
`pkp_ethAddress` is current — prune them from the key set.

---

## Invariants this component preserves

INV-3 (C1 append-only storage), INV-4 (NAME discovery, C1/C2), INV-10 (write auth — see matrix),
INV-2 (record-key set via C2). The site-root/contenthash invariants (INV-6, INV-12) live in the
ENS layer; these modules only provide the `ens_records` pointer and the gate the PKP is checked
against.

## Permissions matrix (publication side)

| target | onlySafe | also allowed |
|---|---|---|
| whitelist mgmt / acceptOffer / upgrade | ✓ | — |
| `makeOffer` | — | **anyone** (creates pending offer unless whitelisted) |
| `retract` | ✓ | the content's `genesisAuthor` (set once on first append, never changes) |
| records (config) writes | ✓ | — |

## Safe-to-change vs do-not-touch

- 🟢 add functions/events; new records keys (coordinate INV-2); enumeration gas/UX; prune GAP-11 keys.
- 🔴 reorder C1 storage (INV-3); change `NAME()` strings (INV-4); loosen `onlySafe`; remove the
  `ens_records` config key or change the `node`/`contenthash_wrapped` conventions (breaks the ENS
  coupling + INV-6).

## Test seams (Foundry/Hardhat)

- C1 offer/deal state machine: `makeOffer` whitelisted → immediate deal; unwhitelisted → pending offer; `acceptOffer` promotes; `retract` by author removes fully; `retract` by safe demotes deal→offer or rejects offer; whitelist caps; `canPublish` truth table.
- C2: `onlySafe` enforcement; enumeration; record round-trip.
- **The gate is the actions' boundary:** unit-test `canPublish`/`hasDeal`/`canRead` return values directly — they are the fixtures `libs/gates.ts` consumes. (`Protocol.test.ts` is the seed.)
