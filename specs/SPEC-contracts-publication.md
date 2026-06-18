# SPEC-contracts-publication

> Per-publication on-chain layer: the two Safe modules. Read **SPEC-00** first. Sibling:
> **SPEC-contracts-ens** (the protocol-wide naming/resolution layer). Pairs with
> **SPEC-protocol-actions** (the actions gate against these modules). Follows SPEC-00 §7.
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

### C1 — `S2SPublicationModule` (UUPS upgradeable proxy)

**State (INV-3 — append-only, DO NOT REORDER):** `licenses`, `licenseAuthors`,
`whitelisted_authors[]`, `whitelisted_devs[]`, `pendingLicenses` (original layout); then
`allContentIds[]`, `contentIdExists`, `contentIdIndex` (added at end). Caps: 100 authors, 20 devs.

**Write API + access control (precise — refines INV-10):**

| fn | who | effect |
|---|---|---|
| `whitelistAuthor/removeWhitelistedAuthor` | `onlySafe` | manage author whitelist |
| `whitelistDev/removeWhitelistedDev` | `onlySafe` | manage dev whitelist |
| `grantLicense(pub, content_id)` | **anyone** | caller ∈ authors ∨ == safe → granted; else **pending offer** (returns false) |
| `acceptLicense(content_id)` | `onlySafe` | promote pending offer → license |
| `revokeLicense(content_id)` | **safe ∨ licenseAuthor** | revoke + remove content id |
| `_authorizeUpgrade` | `onlySafe` | UUPS upgrade |

**Read API (the gate the actions depend on):** `canPublish(addr)` → safe ∨ whitelisted dev ∨
whitelisted author; `isLicensed(content_id)` / `isLicensedBulk`; `isWhitelistedAuthor/Dev`;
`getLicenseAuthor`; content-id enumeration. These back `canPublish`/`canRead` in `libs/gates.ts`.

**Gotchas:** `canPublish` has `// could be safe owners ???` — it checks the Safe *address*, so a
Safe *owner* EOA does **not** pass; unresolved design Q. Whitelist removal ⇏ license revocation.
Factory deploys an `ERC1967Proxy` per Safe; `deployNewImplementation` retains version history.

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
| whitelist mgmt / acceptLicense / upgrade | ✓ | — |
| `grantLicense` | (immediate) | **anyone** (creates pending offer) |
| `revokeLicense` | ✓ | the content's `licenseAuthor` |
| records (config) writes | ✓ | — |

## Safe-to-change vs do-not-touch

- 🟢 add functions/events; new records keys (coordinate INV-2); enumeration gas/UX; prune GAP-11 keys.
- 🔴 reorder C1 storage (INV-3); change `NAME()` strings (INV-4); loosen `onlySafe`; remove the
  `ens_records` config key or change the `node`/`contenthash_wrapped` conventions (breaks the ENS
  coupling + INV-6).

## Test seams (Foundry/Hardhat)

- C1 license state machine: `grantLicense` whitelisted vs pending → `acceptLicense` → `isLicensed`;
  `revokeLicense` by safe vs author vs stranger; whitelist caps; `canPublish` truth table.
- C2: `onlySafe` enforcement; enumeration; record round-trip.
- **The gate is the actions' boundary:** unit-test `canPublish`/`isLicensed`/`canRead` return values
  directly — they are the fixtures `libs/gates.ts` consumes. (`Protocol.test.ts` is the seed.)
