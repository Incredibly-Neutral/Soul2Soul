# SPEC-author-identity — 0xobsidian (author identity, Safe, key custody)

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Sibling:
> [SPEC-author-publishing](SPEC-author-publishing.md), which runtime-depends on this package.
>
> **Audited against live code:** 2026-08-03. Handle registry read against `S2SRegistry.sol`,
> `S2SAuthorGate.sol` and `scripts/deploy-registry.ts` on 2026-11-27.
>
> Component spec for `0xobsidian/` — Obsidian plugin id **`oxo-core`**, the **author identity &
> account** layer. Read **SPEC-00** first; types from **SPEC-shared**. It is the runtime dependency
> of **SPEC-author-publishing** (which reads the active user/accounts from it). Follows SPEC-00 §7.
>
> Invariants touched: INV-1 (the author key produces the `"lit actions auth"` signature the gates
> check) and the cross-chain **same-address** Safe requirement (SPEC-contracts-ens).

## Responsibility

Owns **who the author is** and **their wallet**: a generated keypair (EOA), per-chain **ERC-4337
Safe smart accounts** (gasless via a pimlico paymaster), and the author's **Lens account/profile**.
Also provides shared infra handles (LitService, Lens, IPFS/pinning) to dependent plugins.
Does **not** own publications, content authoring/encryption, or render triggering — that is
neutralpress, which *depends on this plugin*.

**Broader intent (scope beyond S2S).** `oxo-core` is designed as a **general-purpose web3-primitives
provider for the Obsidian ecosystem** — exposing IPFS, blockchain accounts (4337 Safes), Lens, and
Lit to *any* Obsidian plugin, not just S2S. neutralpress (S2S publishing) is **one consumer**. So
this package is closer to reusable *infrastructure* than to S2S domain logic (cf. the
protocol-vs-implementation split, SPEC-00 §0) — its API surface should stay S2S-agnostic, and the
S2S-specific imports it currently carries (e.g. `S2SBody`/`S2SContentInfo` types) are a slight
layering smell worth watching.

## The handle registry

A handle is the author Safe's unique public name. One Safe holds at most one handle, and one
handle names exactly one Safe. On chain the handle is the bare name, `alice`; the CLI prints it as
`alice.s2s`, and that suffix is a display convention only. There is no ENS name, no DNS record and
no onchain suffix: the mapping is the storage of the `S2SRegistry` contract on Base.

The pen name is not the identity. It is free text in the Safe's records module, set by the install
and read by `s2s author bio` ([SPEC-author-cli](SPEC-author-cli.md#the-author-profile-records-s2s-author-bio)).
A handle is unique and resolved by contract; a pen name is a string a page may show.

`S2SRegistry` is non-upgradeable, has no owner, no pause and no upgrade path. It keeps one live
entry per handle, with the fields `safe`, `handle` (the exact registered spelling), `version`,
`registeredAt` and `recordsLocation`. The two reads are the mapping in both directions:
`resolve(handle)` returns the owning Safe or the zero address, and `nameOf(safe)` returns the
handle or the empty string. `entry(handle)` returns the whole live record.

`recordsLocation` is the records module the Safe named at registration. The gate requires that
module to be enabled on the Safe and to answer `safe()` with the registering Safe, so the pointer
names the Safe's own module rather than another author's. The owning Safe may move it later with
`setRecordsLocation`, e.g. after installing a new records module; that call runs the same gate on
the new location, and an address the gate refuses reverts `NotAuthor` with the old pointer still
in place.

### Handle name rules

The rules are byte rules on the raw UTF-8 bytes, checked in this order: length 3 to 32 bytes; then
the bytes `a-z`, `0-9` and `-` only; then no leading, trailing or doubled hyphen; then reservation;
then the skeleton claim; then the cooldown. Uppercase is rejected, never folded, and
`InvalidChar(index)` names the first offending byte. The same structure check runs in `reserve`,
`unreserve` and `assignReserved`, so governance cannot reserve or assign a spelling `register`
would refuse.

### The skeleton

The skeleton is the name lowercased, then every `-` removed, then one pass over the remaining
bytes mapping `0` to `o`, `1` and `i` to `l`, `5` to `s`, `rn` to `m`, and `vv` to `w`. Hyphens go
first, so `corn`, `cor-n` and `c0rn` all fold to `com`: a hyphen between `r` and `n` does not
suppress the fold. The skeleton is what the one-name-per-spelling rule keys on: `alice`, `a1ice`,
`al-ice` and `allce` all claim the same name. `skeletonOf(handle)` is public, pure and canonical
even for input `register` refuses, and validation uses the same function, so `check` cannot
disagree with `register`.

### Reserved names and governance

Governance can `reserve(handles)` and `unreserve(handles)` the skeletons of a list of names, and
`assignReserved(handle, safe, recordsLocation)` a reserved name to a free, gate-checked Safe. It
can also `setAuthorGate` and `transferGovernance`. Its limits are explicit: governance cannot
change a live entry's `safe`, `version` or `recordsLocation`; only the owning Safe can move
`recordsLocation`, through `setRecordsLocation`, which runs the same gate on the new location, and
no function moves the other two. There is also no way to release a handle on another Safe's behalf. `assignReserved` refuses an entry that already
exists, so it can give away an unclaimed reserved name but never move one that is live. It leaves
the reservation set, so a released assigned name returns to the reserved pool, not to public
registration.

### Release, cooldown and versions

`register(handle, recordsLocation)` is called by the Safe itself and reverts `AlreadyRegistered`
before it looks at the name; `release()` deletes the entry and frees every spelling of its
skeleton. A release starts a 90-day cooldown on that skeleton, during which no one may register
it, including the Safe that released it. Versions are keyed to the skeleton, not to the spelling:
`lastVersion[skeletonHash]` survives the release, so after `alice` is released and the cooldown
passes, `al-ice` registers at version 2, not 1. `versionOf(handle)` reads the same slot for every
spelling of the skeleton, and the next registration gets the previous version plus one, so a
version is never reused. A first registration is version 1.

`check(handle)` returns `(available, reason)` and is caller-independent: it does not consider
whether the caller already holds a handle, and `register` still reverts `AlreadyRegistered` in that
case. The reasons are 0 free, 1 invalid character, 2 invalid length, 3 invalid hyphen, 4 reserved,
5 skeleton taken by another spelling, 6 cooling down, 7 this exact handle already registered.
Structure reasons precede the storage checks.

### The author gate

Registration reaches the gate from the registry: `register` and `assignReserved` both call
`IAuthorGate(authorGate).isAuthor(...)`, and only a true answer is written. So a Safe that is not
an author Safe cannot register a handle. Uniqueness is not the gate's job: the registry owns the
mapping, the skeleton claim, the cooldown and the version, and the gate only answers whether the
Safe and the records module are the pair they claim to be.

`S2SAuthorGate.isAuthor(safe, recordsModule)` answers in this order: the Safe has code; its
`codehash` is one of the allowed Safe proxy runtime hashes; its `masterCopy()` is an allowed Safe
singleton; the records module has code; its `codehash` is the allowed module proxy runtime hash;
its `moduleKind()` is `keccak256("s2s.module.records")`; its `factory()` is in the allowed author
factory list; that factory's own `recordsModule(safe)` returns this module; the Safe's
`isModuleEnabled(recordsModule)` is true; and `recordsModule.safe()` returns the Safe. There is no
try/catch: a module call that reverts fails the registration rather than reading as a no.

The Safe proxy code hash proves the bytecode is Safe's proxy runtime code, not who deployed it; a
Safe proxy built outside the canonical factory is accepted, because the registry registers author
Safes, not provenance. Provenance is enforced on the module: a Safe can deploy a stub and enable
it, and a stub can answer `safe()`, `moduleKind()` and `factory()`, but it cannot carry the module
proxy's runtime code, and a proxy from an unlisted factory is refused after the code and kind
match. Copying the proxy code and naming an allowlisted factory is still only a claim, because
`factory()` is answered by the implementation behind the proxy; the gate closes that by asking the
named factory for `recordsModule(safe)` and requiring this module. Only `createRecordsModule`
writes that mapping, so a proxy over an implementation that merely names the factory fails.

The gate's four values are constructor arguments with no setter: the allowed Safe singletons
(`SAFE_SINGLETONS`), the allowed Safe proxy code hashes (`SAFE_PROXY_CODEHASHES`), the allowed
author factories (`AUTHOR_FACTORIES`) and the module proxy code hash (`MODULE_PROXY_CODEHASH`).
Each allowed factory must answer `recordsModule(safe)` with the module being registered.
`S2SRegistry(gate, governance)` fixes the gate and a governance address that must have code, set
by `GOVERNANCE_ADDRESS` (no default). A wrong gate value is permanent in that gate and needs a new
gate plus `setAuthorGate` on the registry. `pnpm deploy:registry` reads `PROTOCOL_PRIVATE_KEY`,
refuses a chain that is not Base, requires the four gate envs and that governance address, and
reads `authorGate()` and `governance()` back before printing the addresses. `RESERVED_HANDLES` is
an optional comma-separated seed list: every name is checked against the handle byte rules before
the first deploy, so one bad seed sends nothing; once the registry exists the list is reserved,
signed by the deployer when it is governance and printed as a call otherwise, and a reverted
reserve receipt fails the run. The registry address the CLI reads is not part of this deployment
record; see [SPEC-author-cli](SPEC-author-cli.md#the-author-handle-s2s-author-handle).

### Non-goals

A handle is not an NFT and not transferable. There is no token, no transfer function and no market:
the owning Safe claims the name and only that Safe can release it.

A handle is not recoverable by governance. Governance can reserve a free name and assign it to a
Safe the gate accepts, but it cannot reassign a live handle. If the Safe's keys are lost, the
handle stays with the Safe; the registry is not a recovery mechanism.

A handle is not an ENS name or a DNS name. It is not a subdomain, it has no resolver outside this
contract, and `.s2s` is not stored on chain.

## Runtime context

Obsidian plugin, **esbuild**-built, with browser polyfills (`polyfills.js`) and a `fetch-interceptor`
(to make web3/Lens SDKs work in Obsidian's Electron environment). Entry `main.ts` (`OxO extends
Plugin`) → `MainController` orchestrates everything. Settings hold `authors[]`; the **active** author
drives init.

## Boundary interfaces

**Consumes:** Obsidian Plugin API; `permissionless` + pimlico (4337 bundler/paymaster); Lens SDK;
Pinata + remote Kubo; shared `LitService` + types.

**Produces (to neutralpress, via the loaded `oxo-core` plugin instance):** the active **`IOXOUser`**
(`{name, active, eoa, private_key, lens?, safe?}`), the per-chain **`account`** map
(`{[chain]: PermissionlessSafeService}`), handles `lit`, `lens`, `pinata`, `ipfs`, `waap`, and
**`storage`** (`FilecoinController` — CAR builder + dual-path upload to Kubo/Filecoin SPs).
neutralpress reads these off `app.plugins.plugins["oxo-core"].ctrlr`.

## Shared surface consumed (bundled into the esbuild output)

Entry point: **`@s2s/soul2soul-shared`** (full index — esbuild handles tree-shaking). Imports:
`LitService` (Chipotle, `prod`); types `S2SBody`, `S2SContentInfo`, `S2SPublicationConfig`,
`S2SRipple`, `S2STemplateConfig`; and Lens helpers (`postToLens`/`updateToLens` family) +
content types (`S2SPublicContent`, `S2SToEncrypt`, `S2SContentItem`) where used. These compile into
the plugin bundle — part of this package's code.

## Sub-component map

| path | role | state |
|---|---|---|
| `main.ts` | `OxO` plugin (onload, settings tab, builds `MainController`) | live |
| `main.ctrlr.ts` | `MainController` — `account` map, `pinata`, `lit` (shared), `lens`; init/newAuthor/initChain | live |
| `user/user.ts` | `OXOUser` — keypair gen (`Wallet.createRandom`), EOA derive, Safe addr, Lens link | live |
| `user/author.modal.ts`, `user/ens.ts` | author UI + ENS helpers | live |
| `eth/permissionless.safe.service.ts` | per-chain **4337 Safe** (publicClient + pimlicoClient + signer) | live |
| `eth/` (safe.contracts, *.abi, tx.factory, provider.factory, chains.factory, waap.service) | Safe contracts/ABIs, tx building, chains | live; **ABIs overlap shared** |
| `paymaster/` (userop.factory, paymaster.factory) | 4337 user-op + paymaster sponsorship | live |
| ~~`lens/lens.ctrlr.ts`~~ | ~~`LensService` — profile check/register, posting (local)~~ | **gone** — file removed (2026-08-07 drift check). Only commented-out remnants remain (`main.ctrlr.ts`: `lens: any` fields + commented `checkLensProfile`/`addLensAccount` calls; `settings.ts`: commented Lens-profile UI). Reconcile whether lens is fully dead — residual `lens: any` fields still typed. |
| `ipfs/` (pinata.ctrlr, remotekubo.service, ipld.factory, pin.factory) | pinning + IPFS (local); **`addJson()`** for dual-path upload | live |
| ~~`lit/_lit.service.ts`~~ | ~~old Lit SDK service (Naga/Chronicle Yellowstone, PKP minting)~~ | **removed** (was DEAD — pre-Chipotle, superseded by shared `LitService`). File deleted; shared `LitService` is current. |
| `filecoin/filecoin.ctrlr.ts` | `FilecoinController` — CAR builder (filecoin-pin, unixfs-v1-2025), `uploadJson` (Filecoin SPs), `uploadToKubo` (delegates `addJson`), `retrieveJson` | **NEW** |
| `settings.ts`, `settings.factory.ts` | persisted `authors[]` (incl. encrypted `key_blob`); `kubo_url` defaulting to `ipfs.transport-union.dev` | live; **plaintext never written** |
| `keystore/keystore.ts` | `IKeystore`, `SafeStorageKeystore`, `PlaintextKeystore` fallback | **NEW** — Track A |
| `keystore/spike.ts` | safeStorage reachability check (A0) | **NEW** — Track A |

## Key flows (from FLOW.md)

- **Init:** `onload` → `MainController.init()` (account map, pinata, shared LitService, LensService)
  → find active author → `OXOUser` (generate keypair if missing) → `checkLensProfile` /
  `addLensAccount`. No active user → stops with a Notice.
- **New author:** `newAuthor()` → OXOUser (keypair) → `initChains(['ETH_MAINNET','BASE'])` →
  `connectToFreshSafe()` (4337) → `addLensAccount` (Lens `createAccountWithUsername`) → save settings.
- **Per-chain:** `initChain(chain)` → `PermissionlessSafeService` (publicClient + pimlicoClient +
  signer) → connect/create Safe.

## Invariants this component preserves

- **INV-1 origin:** the author's `private_key`/EOA signs `hashMessage("lit actions auth")`; that
  signature is what the gates recover and check (`canRead`/`canPublish`). The signer must be an
  **owner of the author Safe** the publication whitelists/licenses — read *now*, which is all a
  signature made today needs. For an artifact signed before a signer rotation, "is an owner" is the
  wrong question and [SPEC-author-owner-history](SPEC-author-owner-history.md) is the record that
  answers the right one ("was an owner at that block").
- **Cross-chain same-address (SPEC-contracts-ens):** the author Safe address must be consistent so
  it can be the ENS subnode owner (L1) and the gated identity (L2). Safe-address determinism is owned
  here (4337 Safe deployment) — do not change derivation casually.

## Local gotchas / gaps (incl. single-source-of-truth violations)

- **`lit/_lit.service.ts` removed** (was dead — pre-Chipotle: `@lit-protocol/*` SDK, `nagaTest`,
  `CRONICLE_YELLOWSTONE`, PKP minting). File deleted; shared `LitService` is current. Done.
- **`lens/lens.ctrlr.ts` gone** — file removed; only commented-out remnants in `main.ctrlr.ts`/
  `settings.ts` (`lens: any` fields + commented calls). Reconcile residual typing + whether the
  neutralpress `oxo.ctrlr.lens.createFeed` call (publication/new.ts) still resolves here.
- **Duplication to consolidate into `shared` (SPEC-00 single-source rule):** Safe factory/
  implementation **ABIs** (`eth/*.abi.ts`) overlap `shared/contracts`; **IPFS/Pinata**
  (`ipfs/*`) overlaps `shared/ipfs` + `shared/pin`; **Lens** posting overlaps `shared/lens`. Each is
  a candidate to dedupe into shared (note: neutralpress likely duplicates some of the same).
- **`IPKPInfo` local type** (`name, tokenId, publicKey`) carries the vestigial pre-Chipotle PKP
  fields (cf. GAP-11).
- **`lit`/`lens` typed `any`** on MainController — weak boundary; tighten to shared types.
- **Private key at rest:** the author `private_key` is encrypted via Electron's
  `safeStorage` (delegates to macOS Keychain / Windows DPAPI / Linux Secret Service)
  before being written to disk. The in-memory `OXOUser.private_key` remains
  plaintext for signing; the on-disk `key_blob` (base64) is encrypted. See
  `src/keystore/keystore.ts` for the implementation, `src/keystore/spike.ts` for
  the runtime check that verified `safeStorage` is reachable.
- **Linux degraded mode:** on headless/minimal Linux where `isEncryptionAvailable()`
  is false, the `PlaintextKeystore` is used with an explicit logged warning on every
  use (no silent fallback). Install `gnome-keyring` or `keepassxc` and restart
  Obsidian to enable encryption.

## Safe-to-change vs do-not-touch

- 🟢 author UI/modal, settings layout, chains list, dead-code removal (`_lit.service`).
- 🔴 keypair generation/derivation; Safe-address determinism (cross-chain + ENS ownership); the
  signer used for `"lit actions auth"` (INV-1); the `oxo-core` plugin id and the `ctrlr` surface
  neutralpress reads.

## Test seams

- `OXOUser`: keypair gen + EOA/Safe address derivation are pure → unit-test determinism.
- `PermissionlessSafeService`: existing `test/integration/safe.service.test.ts` is the seed; assert
  the Safe address is stable across chains for the same owner.
- Auth: assert the EOA signs `"lit actions auth"` and recovers to an owner the publication module's
  `canPublish` accepts (cross-check with publication/SPEC-publication-account gate fixtures).
