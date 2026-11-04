# SPEC-author-identity — 0xobsidian (author identity, Safe, key custody)

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door. Sibling:
> [SPEC-author-publishing](SPEC-author-publishing.md), which runtime-depends on this package.
>
> **Audited against live code:** 2026-08-03.
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
  **owner of the author Safe** the publication whitelists/licenses.
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
