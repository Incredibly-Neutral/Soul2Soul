# SPEC-publication-account — the publication's Safe, its modules, and who may replace them

> **Parent:** [SPEC-publication](../SPEC-publication.md) — the publication front door.
> **Sibling (agreements):** [SPEC-publication-agreements](SPEC-publication-agreements.md) — the offer/deal
> state machine these modules host. **Sibling (naming):** [SPEC-contracts-ens](../SPEC-contracts-ens.md).
>
> **Type:** component spec. It owns *existence*: how a publication's account comes to be, what is hung
> on it, who can change the code behind it, and how it is taken apart. It does **not** own what the
> modules do (that is the agreements child) or the ENS layer.
>
> **Audited against live code:** 2026-10-30 (source reading; no chain state was read — see
> [what is not verified](#what-is-not-verified)).
>
> **Folded from:** `SPEC-contracts-publication` (C1 proxy/deploy/upgrade, teardown), `SPEC-safe-app`
> (`lib/publication-init.ts`, `lib/ens-registration.ts`), `SPEC-contracts.md` (the split router).

---

## Responsibility

A publication is **one Safe on two chains at one address**, with exactly two purpose-built modules
enabled on the Base instance. Everything else about a publication is either a record in those modules
or a CID. This spec covers:

- address determinism (the same address on L1 and L2, from a name);
- the two creation routes (CLI deployment, admin-app initialisation of an existing Safe);
- module deployment through factories, and how the app finds them afterwards;
- upgradeability — per publication, and the factory's own;
- teardown.

## Address determinism

| | value |
|---|---|
| salt | `'publication_safe_' + name` |
| saltNonce | `keccak256(salt)` |
| Safe implementation | SafeL2 v1.4.1 |
| EntryPoint | v0.7 (part of the address, via the 4337 module) |
| consequence | `publicationAddress1 === publicationAddress2` — asserted in `shared/src/publication/new.ts` |

The name is the only input. Two publications cannot share a name and a salt, which is why the name is
also the ENS label (`<name>.eth`, or a subname of the protocol's parent) and the record key
`records.name`. Renaming a publication is therefore not a rename: it is a different address.

## Two creation routes

Both end in the same shape. They differ in who owns the Safe while it is being built.

### Route A — CLI

1. `connectToFreshSafe('publication_safe_' + name)` on L1 and L2 → same address, both returned.
2. `registerSubdomain` on **L1**, as its own step. It cannot be batched with anything: the registry has
   no code on Base, so there is nothing to batch it with.
3. Create both modules on L2 through the two factories.
4. `verifyModulesEnabled` — poll ≤ 20 times at 5 s.
5. `setRecordsWithRetry` — one `setRecords` call writing all five keys (`name`, `config`, `repo`,
   `branch`, `feed`), retried 3× at 3 s. `config` may legitimately be empty at this stage.
6. Per remaining owner: `addOwnerWithThreshold(owner, 1)`, batched on both chains, then
   `verifyOwnersAdded`.
7. `removeInitialSigner` — 3 retries, with the linked-list `prevOwner` computed.

**Step 7 is where N-of-N comes from.** Lowering the threshold to 1 for each added owner and then
removing the deployer leaves `threshold == owners.length`. There is no owner-management UI in the app,
so a publication that wants 2-of-3 has to finish in Safe{Wallet} afterwards. This is a deliberate
safety default (no single signer can act) and a UX cliff, in that order.

### Route B — admin app

For an **existing** Safe that is not yet a publication (`safe-app/src/lib/publication-init.ts`). Two proposals, not three:

| batch | contents | on |
|---|---|---|
| 1 | `recordsFactory.createModule(safe)`, `publicationFactory.createModule(safe, authors, [])` | Base |
| 2 | `enableModule(records)`, `enableModule(publication)`, `setRecord("name")`, `setRecord("repo")?`, `setRecord("branch")?` | Base |

Batch 2 is atomic for a reason worth recording: `setRecord` is `onlySafe` and does **not** require the
module to be enabled, so the whole finalisation fits one MultiSend and the half-initialised state
("modules enabled, name never written") is unreachable. `enableModule` is idempotent, so re-proposing
the batch during a recovery is harmless. An earlier three-proposal flow had exactly that dead end.

**Module addresses cannot be predicted, so they are read back.** `createModule` uses plain `CREATE`,
and `Safe.enableModule` is `onlySelf` and does not check that the target has code — so the app reads
`ModuleCreated` events from the transaction receipt: last matching log per factory, within a
10 000-block lookback, `safe` in topic 1, module in topic 2.

After batch 2 the flow waits on a human: poll `isModuleEnabled` every 2 s for up to **10 minutes**
(`DEFAULT_ENABLE_TIMEOUT_MS = 600_000`). The app cannot confirm its own proposal; a holder has to.

## What is hung on the Safe

| module | kind | NAME | notes |
|---|---|---|---|
| `S2SPublicationModuleV2` | `ERC1967Proxy` → `Initializable + UUPSUpgradeable` impl | `"S2S Publication Module V2"` | per publication; holds agreements + whitelists |
| `S2SRecordsModule` | immutable, v1.1.0 | `"S2S Records Module"` | KV records: `name`, `config`, `repo`, `branch`, `feed`, `ens_records` |
| ERC-4337 module | installed by the Safe host | n/a | the only module on the **author** Safe; a publication Safe created by route A may carry it too |

`S2SRecordsModule` is enabled as a module purely for **discovery** (INV-4 — an app enumerates
`getModulesPaginated` and matches `NAME()`); functionally the Safe *calls into* it, and every write is
`onlySafe`.

**Discovery accepts two names, asymmetrically.** `shared/src/authoring/publication.ts:118` and
`shared/src/protocol/index.ts:265` accept both `S2S Publication Module V2` and the V1 string
(backwards compatibility). `safe-app/src/lib/safe-integration.ts:132` accepts only the V2 string. A
component that sniffs modules must therefore decide which convention it is following; the app is
stricter than the shared layer, which is the correct direction but is not uniform.

**There is no ownership check on adoption.** The app matches a module by `NAME()` and uses it; it never
compares `module.safe()` to the Safe it is talking to. A `NAME()` match is not evidence of ownership —
see [the upgrade edge](#upgradeability).

## Upgradeability

Two independent upgrade surfaces, and they are not equally guarded.

**Per publication — guarded.** `upgradeToAndCall` arrives through `UUPSUpgradeable`; the contract
implements `_authorizeUpgrade` as `onlySafe`. Only the publication's own Safe can replace its
implementation. Storage layout is append-only (INV-3), so an upgrade cannot reorder what exists.

**Per deployment — not guarded.** `S2SPublicationModuleV2Factory`:

| fn | access control | effect |
|---|---|---|
| `createModule(safe, authors[], devs[])` | **none** | deploys a proxy; emits `ModuleCreated` |
| `createModuleEmpty(...)` | **none** | same, empty lists |
| `setImplementation(address)` | **none** | changes what *future* publications get |
| `implementationHistory` | read | append-only list of former implementations |
| `safeModules` / `getModulesForSafe` | read | the factory's own index |

So the honest statement of the trust edge is: **a per-publication upgrade needs that publication's
holders; what code a publication is born with needs nobody in particular.** A publication created
tomorrow trusts whoever last called `setImplementation`. `S2SRecordsModuleFactory.createModule` has
the same shape (plain `CREATE`, no access control, non-idempotent).

`_authorizeUpgrade` being `onlySafe` is why the app's whole write model — propose, never send — is
also the upgrade model, and why removing upgradeability changes the app as well as the contract.

## Teardown

`buildDeletePublicationBatch` proposes `[disableModule(prev, later), disableModule(prev, earlier),
deleteRecord("name")]`, in **descending** list order because `disableModule` takes the *previous*
module in the linked list (sentinel `0x…001`). The name record is deleted only when it is known and
not suppressed — deleting an unwritten key reverts `KeyNotFound`, which would blow up the gas estimate
for the whole batch.

What teardown does **not** do: unpin any CID, re-render or remove any page, unregister the ENS subname,
or delete the Safe. It removes the publication's *ability to act*, and leaves the site standing.

## Invariants

- **INV-3 — append-only storage.** C1 declaration order is part of the contract: `safe`, `versions`,
  `genesisAuthor`, `latestIndex`, `whitelisted_authors`, `whitelisted_devs`, `_isDeal`, `dealList`,
  `dealPos`, `dealAt`, `_isOffer`, `offerList`, `offerPos`, `offerAt`, `__gap`. Never reorder.
- **INV-4 — discovery by `NAME()`.** The strings above are interface, not branding.
- **INV-10 — write authorisation.** Every mutation is either `onlySafe` or explicitly enumerated; the
  matrix lives in the agreements child and in [the front door](../SPEC-publication.md#permissions).
- **Two addresses, one account.** An L1 write (subnode registration) and an L2 write (modules) act as
  the same Safe because the address is chain-independent.
- **Creation is not idempotent at the factory, only at `enableModule`.** Re-running route B is safe;
  re-running route A is not (it would deploy a second set of modules).

## Safe-to-change vs do-not-touch

- 🟢 add module functions/events; add records keys (coordinate INV-2 with the readers); improve
  enumeration gas; add an owner-management surface; add an ownership check on adoption (additive).
- 🟢 add access control to either factory — strictly additive, nothing depends on it being open.
- 🔴 reorder C1 storage (INV-3); change `NAME()` strings (INV-4); loosen `onlySafe` on the records
  module or `_authorizeUpgrade`; predict module addresses instead of reading logs; make route A
  idempotent by reusing an existing module.

## Test seams

- Route A: assert `publicationAddress1 === publicationAddress2`; assert final `threshold == owners.length`.
- Route B: a mocked receipt with two `ModuleCreated` logs → assert the app picks the last per factory and
  the right topic indexes; assert batch 2 is one MultiSend and includes the name record.
- Discovery: a Safe with a V1-named module → `shared` resolves it, the app does not (this asymmetry is
  currently untested and is the thing most likely to bite).
- Upgrade: `upgradeToAndCall` from a non-Safe EOA reverts; from the Safe succeeds and
  `implementationHistory` grows.
- Teardown: `disableModule` ordering against a 3-module list; `deleteRecord` suppressed when the name is
  unknown.

## What is not verified

- That deployed bytecode matches this source, and that any live publication's module is the
  implementation the factory records last.
- Whether any live publication is N-of-N, or has ever been through route B.
- Which modules a live publication actually has enabled — the app's own view of this was not read.
