# SPEC-publication-account — the publication's Safe, its modules, and who may replace them

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Sibling (agreements):** [SPEC-publication-agreements](SPEC-publication-agreements.md) — the offer/deal
> state machine these modules host. **Sibling (naming):** [SPEC-contracts-ens](SPEC-contracts-ens.md).
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

**Module addresses are computable, and the app still reads them back.**
`S2SPublicationModuleV4Create2Factory.createModule` deploys with `CREATE2`, so `moduleAddress(safe)`
answers before the batch is proposed — the module the factory already made for that safe, or the
address the create will deploy at when there is none. Against `S2SPublicationModuleV3Factory`, whose
`createModule` uses plain `CREATE`, there is nothing to compute: `Safe.enableModule` is `onlySelf` and
does not check that the target has code, so the receipt is the only proof a module exists, and the
app reads `ModuleCreated` events from it — last matching log per factory, within a 10 000-block
lookback, `safe` in topic 1, module in topic 2.

Both front ends ask the CREATE2 factory first and keep the log read as the fallback. The answer is a
statement about the factory, not about the Safe: `moduleAddress(safe)` reports the module recorded for
that safe when there is one, and otherwise the prediction under `latestImplementation`. So it names a
create that has not happened only for a safe without a module, and `setImplementation` moves it only
for that safe. A publication created earlier keeps reporting the address it was born at; where a
create under a given generation would have landed is `moduleAddressForVersion(safe, version)`, 1-based
over `implementationHistory`, which reverts `InvalidVersion` outside `1..implementationCount()`. The
prediction is the address alone: the factory constructs the proxy with empty initializer data and
calls `initialize(safe, authors, devs)` on it afterwards, so the authors array cannot move it.

The caller still confirms: it accepts the publication module from the factory only when that address
has code and the Safe lists it, since a disabled module keeps its code and every write to it reverts.
Route B uses the same answer as its existence check before proposing the create: code at
`moduleAddress(safe)` is a publication older than the log window, which the `ModuleCreated` scan alone
would miss and re-create. A factory that reports nothing leaves the log scan as the fallback.
The records module has no prediction — its factory is plain `CREATE` — so its address still comes from
the log. A factory from the V2 generation answers none of the three selectors; the revert is the
fallback signal, and `NAME()` still decides the ABI version either way.

After batch 2 the flow waits on a human: poll `isModuleEnabled` every 2 s for up to **10 minutes**
(`DEFAULT_ENABLE_TIMEOUT_MS = 600_000`). The app cannot confirm its own proposal; a holder has to.

## What is hung on the Safe

| module | kind | NAME | notes |
|---|---|---|---|
| `S2SPublicationModuleV5` | `ERC1967Proxy` → `Initializable + UUPSUpgradeable` impl | `"S2S Publication Module V5"` | per publication; the implementation a proxy running V2 or V3 upgrades to. V4's surface and storage prefix minus V4's `factory` slot: the factory that approves upgrades, and the protocol safe it must answer, are immutable constructor arguments and are never written to storage. Slot 119 holds a bool, the backfill sentinel `initialize` sets. No `__gap`; nothing is declared after it |
| `S2SPublicationModuleV4` | `ERC1967Proxy` → `Initializable + UUPSUpgradeable` impl | `"S2S Publication Module V4"` | frozen. V3's surface and storage prefix, plus one appended slot for the factory address, written in `initialize` from `msg.sender` and never settable afterwards. A proxy upgraded to V4 in place never ran `initialize` as V4, so that slot is zero and its own check reverts `NoFactory()` on every later upgrade — which is why V5 exists |
| `S2SPublicationModuleV3` | `ERC1967Proxy` → `Initializable + UUPSUpgradeable` impl | `"S2S Publication Module V3"` | frozen: still what publications created under it run, and upgradable only by its own Safe, with no approval check — the pre-V4 right |
| `S2SPublicationModuleV2` | `ERC1967Proxy` → `Initializable + UUPSUpgradeable` impl | `"S2S Publication Module V2"` | history; holds agreements + whitelists under the pre-V3 names |
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

**Per publication — guarded, and not by the owners.** `upgradeToAndCall` arrives through
`UUPSUpgradeable`; `_authorizeUpgrade` is `onlySafe`, so the publication's Safe is `msg.sender` and
no third party reaches the call. The Safe no longer chooses the code. A module running V5 accepts
only the target the factory approved, and only while it is the newest one the factory set.
`_authorizeUpgrade` asks the factory in its immutable `FACTORY` for
`isApprovedImplementation(newImplementation)` and reverts `ImplementationNotApproved(address)` when
that answers false; then it reads `latestImplementation()` and reverts
`ImplementationNotLatest(implementation, latest)` when the target is any other address. V2 and V3
authorise with `onlySafe` alone and V4 accepts any approved implementation, so the newest-only rule
binds a proxy from the block it runs V5. V5's constructor refuses a factory with no code,
`InvalidFactory(address)`, and a factory whose `protocolSafe()` is not its second constructor
argument, `ProtocolSafeMismatch(address,address)`; V4 kept the same address in a storage slot
written by `initialize`. That check catches a wrong factory at the only
moment it can be caught, before the immutable is fixed, and it is not proof that the factory is the
protocol's: the binding act is the protocol safe's `setImplementation` on that factory, and an
implementation it has not recorded is a target no proxy can reach.

Approval is still append-only: the factory's constructor and every `setImplementation` append to
`implementationHistory` and nothing clears an entry, and each entry answers `factory()`, which the
constructor and `setImplementation` check by staticcall before adding one, refusing
`ImplementationWithoutUpgradeGate(address)` otherwise. That check is a presence test, not a proof of
what an implementation does with the field. Legality comes from the `latestImplementation()`
comparison, and the reason for it is the storage layout. A proxy born as V5 holds the bool `1` in
slot 119; V4 reads that slot as its factory address, so on a proxy sitting on V4 the approval read
goes to `address(1)`. That address has no code, the call returns nothing, and the read cannot answer,
so the upgrade reverts. Every later upgrade on that proxy reverts the same way, the publication's
Safe has spent its one upgrade, and the module can never change again. An earlier V5 build carries
no latest read and accepts any approved implementation, so once the protocol safe sets one again, a
proxy moved to it is governed by the approval rule alone: V4 is reachable again, and so is every
other approved build.

So a proxy can name nothing but the newest implementation the factory set. The protocol safe can put
an earlier one back at the front: `setImplementation` accepts an address already in
`implementationHistory`, appends it again and moves `latestImplementation` to it, because the factory
only appends to that history. That is the protocol's own authority, not a publication's, and it acts
on every proxy at once rather than one. It is the remaining trust in this gate: a publication's Safe
cannot reach the freeze without the protocol first making the freezing code the legal target. The
cost to a publication is that it cannot roll back on its own: an older implementation becomes legal
only when the protocol safe sets it again. Publishing also cannot diverge from upgrading,
because `createModule` deploys at `latestImplementation` while the gate demands the same address. An
upgrade a publication has already queued reverts `ImplementationNotLatest` if the protocol safe sets
a different implementation first. Storage layout is append-only (INV-3), so an upgrade cannot reorder
what exists.

V4's `NoFactory()` case is why V5 has no factory slot. A proxy upgraded to V4 in place never runs
`initialize` as V4, so the slot stays zero and every later upgrade reverts `NoFactory()`: the
publication keeps working and can never change implementation again. V5 answers the factory from its
code, so a proxy born under V2 gets it on its first hop, and V2's own `onlySafe` right is what carries
that hop. A proxy already on V4 is stranded: `NoFactory()` comes from the code running at the time, so
V5 cannot be the implementation it upgrades to. The factory's legacy set is not consulted on the way in, which matters because it was frozen
at the factory's construction: a V2 publication running an implementation that set does not name
cannot be registered, and cannot be created again, so the hop is the only route left to it.

Upgrading a V2 proxy means `upgradeToAndCall(V5, reinitializeV3())`. `reinitializeV3()` is
`reinitializer(2)` (selector `0xbac22bb8`) and backfills `agreementsHeldBy` once; it reverts once that
nonce is spent, and also when slot 119 holds the sentinel `initialize` set, because the backfill
increments counts `_addAgreement` already made. A proxy that has already run it, or was born as V5, is
upgraded with a payload that changes nothing, `NAME()` (selector `0xa3f4df7e`).
`scripts/upgrade-publication.ts` reads the proxy's implementation, `NAME()` and initialisation nonce and
derives which of the two applies; it refuses a V4 target by name, because V4's permanent approval and a
V2 proxy's `onlySafe` would otherwise let a Safe batch spend the only upgrade on the brick. An empty payload is not an option on any module in this
tree: OZ 4.9's `upgradeToAndCall` force-calls the implementation even with `0x`, and no module here
has a `receive` or `fallback`, so the delegatecall reverts and takes the upgrade with it.

**Per deployment — guarded, one address.** `S2SPublicationModuleV3Factory`:

| fn | access control | effect |
|---|---|---|
| `createModule(safe, authors[], devs[])` | the named safe, or the protocol safe on its behalf | deploys a proxy; emits `ModuleCreated` |
| `createModuleEmpty(safe)` | same | same, empty lists |
| `setImplementation(address)` | **the protocol safe only** | changes what *future* publications get |
| `implementationHistory` | read | append-only list of former implementations, 1-based |
| `safeModules` / `getModulesForSafe` | read | the factory's own index |

It deploys V3. Its `setImplementation` takes any address, so a V4 implementation set here
would still answer `factory()` and still gate upgrades, but nothing would predict the addresses of the
modules it made. A V5 implementation bound to this factory is worse: it has no approval set to read,
so its own upgrade check reverts on an absent selector and the proxy can never change implementation.
The tree does not construct either pair: the deploy script offers the CREATE2 factory alone, and a V4
or V5 implementation is deployed against it.

**Per deployment — guarded, one predictable address.** `S2SPublicationModuleV4Create2Factory` is the
same surface, deploying whatever implementation the protocol safe sets — V4 today, V5 once it is
approved — with the same six errors and three views on top of it, plus the module index below. It keeps the create2 salt, the prediction views, the protocol-safe gate and the
idempotent `createModule`, and adds the check that an implementation it approves carries the gate: a
candidate must answer `factory()` to be set, by the protocol safe at construction or later. It is the
only CREATE2 factory in the tree and is not deployed.

| fn | access control | effect |
|---|---|---|
| `createModule(safe, authors[], devs[])` | the named safe, or the protocol safe on its behalf | returns the recorded module, deploying and emitting nothing, when the safe already has one — the adopted one first, then the created one; otherwise deploys a proxy at `moduleAddress(safe)`, empty, then calls `initialize(safe, authors, devs)` on it in the same transaction; emits `ModuleCreated` |
| `createModuleEmpty(safe)` | same | same, empty lists |
| `setImplementation(address)` | **the protocol safe only** | changes what *future* publications get, adds to the approved set, and becomes `latestImplementation()`, the only target a V5 upgrade may name; an address already in `implementationHistory` is appended again, which makes an earlier implementation the legal target for every proxy at once; refuses an implementation that does not answer `factory()` with `ImplementationWithoutUpgradeGate(address)` |
| `isApprovedImplementation(address)` | read | true for every implementation in `implementationHistory`; the set is append-only and each entry carries the gate. V4 accepts any of them; V5 accepts one only when it also equals `latestImplementation()`, and refuses the rest with `ImplementationNotLatest(implementation, latest)` |
| `moduleAddress(safe)` | read | the module `safe` runs, in the order the record is read: the adopted module (`registeredModule`), else the one `createModule` deployed, else the prediction under `latestImplementation` |
| `moduleAddressForVersion(safe, version)` | read | where a create under that implementation would have landed; 1-based over `implementationHistory`, reverts `InvalidVersion` out of range |
| `implementationHistory` / `implementationCount` / `getImplementationByVersion` | read | append-only, 1-based |
| `registerModule(safe, module, implementation)` | **the protocol safe only** | adopts `module` as the module `safe` runs, so `moduleAddress(safe)` answers it; refuses a zero safe, zero module or zero implementation (`ZeroAddress`), a module without code (`NotAContract`), a module whose `safe()` is not `safe` (`SafeMismatch(safe, moduleSafe)`), a different module for a safe that already has one adopted (`AlreadyRegistered(safe, existing)`), and an implementation the branch does not admit: not approved when the module answers `factory()` with this factory, not legacy when it does not (`ModuleNotRecognised(module)`); identical re-register returns quietly; emits `ModuleRegistered(safe, module, implementation)` |
| `isLegacyImplementation(address)` | read | true for each implementation the constructor recorded as V2/V3; written once, no setter; refuses an entry that answers `factory()` with `LegacyImplementationWithUpgradeGate(address)` |
| `safeModules` | read | the created half of the record: at most one proxy per safe, written by `createModule` and never overwritten |
| `registeredModule` | read | the adopted half: one module per safe or the zero address, written by `registerModule` and nothing else |
| `getModulesForSafe` | read | one address per safe: the adopted module if there is one, else the created one, else nothing |

The salt is `keccak256(abi.encode(keccak256("s2s.publication.module"), safe))`: fixed per safe, no
counter and no caller input, so one publication has one module address and nobody can grind a salt.
The proxy is deployed with empty calldata and initialised afterwards, so its init code is the
`ERC1967Proxy` creation code plus `abi.encode(implementation, "")` — no argument lists, which is why
the prediction depends on the safe alone and `createModule` and `createModuleEmpty` land on the same
address. A revert in `initialize` reverts the proxy deployment with it, leaving nothing at the
predicted address.

The implementation is part of that init code, so `setImplementation` moves the prediction. A safe
with no module sees `moduleAddress` move; a safe that already has one keeps reporting that module,
because `moduleAddress` is the address `createModule` returns right now. Where a create under an
older implementation would have landed is the other question, and `moduleAddressForVersion` answers
it: a generation, not the module the safe has. Because the
address is one per safe, `createModule` is idempotent: a safe that already has a module gets it back,
with nothing deployed and no second `ModuleCreated`, and the lists of the repeat call are ignored.

The protocol safe is `immutable`, fixed at construction, and it is the only address that can name an
implementation. `createModule` names a safe the caller must be: a third party cannot mint a module
carrying somebody else's safe, which is what keeps `getModulesForSafe` honest.

The constructor's code checks cover the protocol safe, the implementation and each legacy
implementation, and the legacy entries are also refused when they answer `factory()`. An EOA cannot
be set as the **protocol safe**; that is the point, since a key-controlled "safe" would make one
leaked key enough to redirect every future publication. The named safe in `createModule` is not
code-checked: the gate already requires `msg.sender == safe`, so an address without code can only
ever name itself, and a module bound to an EOA is one nobody else can upgrade or write to.

### The index is the identity

The factory answers a second question: which module does this publication run. It answers with an
address — never `NAME()` — read in a fixed order: `registeredModule(safe)`, the module the protocol safe
adopted; else `safeModules[safe]`, the proxy `createModule` deployed; else the prediction under
`latestImplementation`. A module with the same string as another is a different module, a proxy over
the same implementation is a different module, and nothing in either half is read from what the code
calls itself. `NAME()` is a claim the module makes about itself, and a Safe can enable any module it
likes (INV-4, and [the upgrade edge](#upgradeability)).

The record answers what this factory knows. It does not replace the Safe: INV-4 makes the Safe's
enabled-module list the authority on discovery, and that stands. A module the Safe does not list, or
has since disabled, is not one to read, whatever the factory answers. The record says which module the
protocol considers the publication's; the Safe says whether the publication still uses it.

The two halves are kept apart because different callers write them. `createModule` writes
`safeModules[safe]`, and it is callable by the safe it names, so a publication's Safe can always deploy
a bare proxy over `latestImplementation` — empty storage, no version log — for its own address. Had
adoption written the same mapping, that create would take the entry first and `registerModule` would
revert `AlreadyRegistered` for the module the publication actually runs, permanently, and a reader
trusting the record would read a module with no publication in it. `registerModule` writes
`registeredModule[safe]` instead, and every read prefers it: adoption outranks creation, a later
`createModule` returns the adopted module and deploys nothing, and that hostile order ends with the
adopted module as the answer.

The constructor is `(address protocolSafe, address implementation, address[] legacyImplementations)`.
Each legacy entry must have code — `ZeroAddress` on a zero entry, `NotAContract(address)` on one
without — and must not answer `factory()`: a gated implementation belongs in the approved set, and
`LegacyImplementationWithUpgradeGate(address)` refuses one pasted here, since recording it would put
the widest acceptance under the branch that checks nothing. Each accepted entry is recorded with
`LegacyImplementationRecorded(address indexed implementation)`. The set is written once, at
construction, and has no setter: what the factory will recognise cannot be widened after deployment.
`isLegacyImplementation(address)` is the read.

`registerModule(safe, module, implementation)` is the protocol safe's write, never the publication's.
A publication's Safe may enable whatever it wants; only the protocol safe can make this contract say
which module is the publication's. A zero safe, a zero module, a zero implementation and a module
without code are refused. So is a module that answers `safe()` with an address other than `safe` —
`SafeMismatch(safe, moduleSafe)` — which stops a module minted for one publication being filed under
another, and keeps a bare implementation address out even when its address is in the legacy set, since
a bare implementation has no storage and answers zero. Adoption is final on its own side: the same
module again returns quietly, a different one reverts `AlreadyRegistered(safe, existing)`, and the
event is `ModuleRegistered(address indexed safe, address indexed module, address implementation)`.

A module is accepted on one of two facts. It answers `factory()` with this factory's address and the
named `implementation` is in the approval set: a proxy this factory deployed, whose upgrades the
factory governs. Or it does not, and the named `implementation` is in the legacy set: a V2 or V3
publication, at the plain-CREATE address it cannot leave, whose proxy was upgraded to V4 in place.
Re-creating such a publication at its CREATE2 address would be a different proxy with empty storage,
not a move, which is why the legacy population is adopted rather than redeployed.

`implementation` is an argument because the ERC-1967 slot (`0x360894a1…382bbc`) is legible over RPC,
not from inside a contract: `sload` in the factory reads the factory's own storage, and no EVM
operation reads another account's. What the legacy branch establishes is that the protocol safe named
a recorded implementation for a module that does not claim this factory — recognition, not proof of
what the module runs. A proxy upgraded since names an implementation it no longer delegates to; a bare
implementation address, or any contract that answers `safe()` with the right address, is accepted on
the name alone. The slot read is the protocol safe's own, over `eth_getStorageAt`, before it builds the
proposal, and the factory cannot repeat or check it. Only the `factory()` branch ties a module to a
code path this contract governs.

The order for the legacy population is read, register, upgrade. The slot is read while the proxy still
runs V2 or V3, at `0x360894a1…382bbc` with `eth_getStorageAt`, and that address is what the constructor
records and what `registerModule` is given; the upgrade to V4 in place comes after. Reading the slot
after the upgrade returns the V4 implementation, and the factory refuses a V4 address as a legacy entry
— `LegacyImplementationWithUpgradeGate(address)` from the constructor, `ModuleNotRecognised(module)` from
`registerModule` — so an operator who upgrades first has nothing to register, and the set has no setter,
so there is no way back.

**A registration is live as soon as it executes.** `readModuleAddress` asks `moduleAddress`, and
`moduleAddress` prefers `registeredModule`, so every reader holding the `publication_factory` record
sees the adopted module the moment the write lands: `resolvePublicationModules` in
`src/shared/src/authoring/publication.ts`, `getProtocolControllerAndModules` in
`src/shared/src/protocol/index.ts`, the safe-app's `resolveModuleAddress` in
`src/publication/safe-app/src/lib/publication-init.ts` and `getModuleAdresses` in
`src/author/neutralpress/src/publication/publication.service.ts` all resolve through it. The adopted
entry cannot be moved afterwards, so there is no window in which a reader reverts to the old address.
What has not changed is the proof: a factory answer counts only when the Safe lists that address
(INV-4), so a registered module the Safe has not enabled is not read, and the `NAME()` match remains
the fallback for a factory that answers nothing. Nothing in the tree calls `registerModule` yet:
`scripts/register-module.ts` encodes the call and prints a Safe batch, and the write stays the
protocol safe's to make.

So the trust edge is: **what code a publication runs, at birth and after every upgrade, is set by the
protocol's governance, not by the publication's holders.** The Safe can carry out an upgrade and
cannot choose what the upgrade contains. Nobody else can change it either. Moving to V4 is not a way
out of the gate: a V3 module that upgrades to V4 keeps working and can never upgrade again, the
`NoFactory()` case above. V5 is the way for a publication that already exists: the proxy upgrades in
place, keeps its log, and the gate applies from that block on, since the factory is in the code and
nothing has to be written to storage first. A publication that skips a release upgrades to the current
one, because the newest set implementation is the only legal target. For a publication with nothing
to keep,
`createModule` on
the CREATE2 factory mints a new proxy at a new address with an empty version log and no offers or
agreements. That publication starts from nothing, and reads of the old log stop at the old address.

**The gate binds a module, not a publication.** A publication Safe can enable a second proxy that
answers the publication module's `NAME()`, disable the gated one, and the contract cannot prevent it:
the Safe is the only caller, and which module it enables is its own choice (INV-4). What the readers
rely on is precedence, not a probe. `resolvePublicationModules` in
`src/shared/src/authoring/publication.ts` takes the factory's prediction and keeps it only when the Safe
lists that address, and uses a `NAME()` match only when the factory answers nothing (the same proof of
the prediction, against the Safe's list, is in `getProtocolControllerAndModules` in
`src/shared/src/protocol/index.ts`, in the safe-app's `resolveModuleAddress` in
`src/publication/safe-app/src/lib/publication-init.ts`, where the proof is code at the address, and in
`getModuleAdresses` in `src/author/neutralpress/src/publication/publication.service.ts`). None of them
asks a module for `factory()`. A substituted proxy the factory would not predict is therefore not
served while the prediction stands, and the app cannot be pointed at an ungated copy of the current
surface. Nothing here stops an owner running V1 or V2 code under their own name, or withdrawing the
name altogether: the gate protects the implementation of a publication that keeps its identity, not the
identity.

The V2 factory deployed at `0xe948735151c43183accd8e85b992952b2711d554` cannot be patched: no admin,
no proxy, no initializer, so its `setImplementation` stays callable by anyone forever. V3 supersedes
it; the migration is a new factory address in the `publication_factory` record, not a repair. The
CREATE2 generation supersedes V3 the same way, and predicted addresses count only from the factory
that produced them: a module at `moduleAddress(safe)` on the V3 factory is not the same address on
this one. `S2SRecordsModuleFactory.createModule` is still ungated (plain `CREATE`, non-idempotent).

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

The init run that follows a teardown cannot start over: the publication module is still deployed, so the
CREATE2 factory returns the module it already made for that Safe and the run re-enables it with its
original authors and devs — the whitelist is what changes them, not a second init — while the records
module is the only fresh one, because the records factory is still non-idempotent.

## Invariants

- **INV-3 — append-only storage.** C1 declaration order is part of the contract: `safe`, `versions`,
  `genesisAuthor`, `latestIndex`, `whitelisted_authors`, `whitelisted_devs`, `_isDeal`, `dealList`,
  `dealPos`, `dealAt`, `_isOffer`, `offerList`, `offerPos`, `offerAt`, `__gap`. Never reorder.
- **INV-4 — discovery by `NAME()`.** The strings above are interface, not branding.
- **INV-10 — write authorisation.** Every mutation is either `onlySafe` or explicitly enumerated; the
  matrix lives in the agreements child and in [the front door](SPEC-publication.md#permissions).
- **Two addresses, one account.** An L1 write (subnode registration) and an L2 write (modules) act as
  the same Safe because the address is chain-independent.
- **Creation is idempotent at the CREATE2 factory, and at `enableModule`.**
  `S2SPublicationModuleV4Create2Factory.createModule` returns the module it already made for a safe,
  so re-running route A against it is harmless; against `S2SPublicationModuleV3Factory` it still
  deploys a second set. Route B is safe either way, because `enableModule` is idempotent.

## Safe-to-change vs do-not-touch

- 🟢 add module functions/events; add records keys (coordinate INV-2 with the readers); improve
  enumeration gas; add an owner-management surface; add an ownership check on adoption (additive).
- 🟢 add access control to either factory — strictly additive, nothing depends on it being open.
- 🟢 supersede a factory with a new generation at a new address — that is what the CREATE2 factory is,
  and it is the only way to change a deploy path already on chain.
- 🔴 overwrite an entry in the module index, give `registerModule` a caller other than the protocol
  safe, or give the legacy set a setter after construction; reorder C1 storage (INV-3); change `NAME()`
  strings (INV-4); loosen `onlySafe` on the records
  module or `_authorizeUpgrade`; let `_authorizeUpgrade` accept an implementation the factory has not
  approved, or give the factory address a setter after `initialize`; make `createModule`
  non-idempotent or give it a caller-chosen salt in the CREATE2 factory, whose address must stay a
  function of the safe alone; predict addresses against
  a factory whose `createModule` uses plain `CREATE` (V2, V3) instead of reading logs back; make route A
  idempotent by reusing an existing module.

## Test seams

- Route A: assert `publicationAddress1 === publicationAddress2`; assert final `threshold == owners.length`.
- Route B: a mocked receipt with two `ModuleCreated` logs → assert the app picks the last per factory and
  the right topic indexes; assert batch 2 is one MultiSend and includes the name record.
- Discovery: a Safe with a V1-named module → `shared` resolves it, the app does not (this asymmetry is
  currently untested and is the thing most likely to bite).
- Upgrade: `upgradeToAndCall` from a non-Safe EOA reverts `OnlySafe`; from the Safe to an
  implementation the factory never approved reverts `ImplementationNotApproved`; from the Safe to an
  approved implementation that is not the newest reverts `ImplementationNotLatest(implementation,
  latest)`, so a former implementation is a legal target on V4 and on V5 only once the protocol safe
  sets it again; from a module with no factory recorded it reverts `NoFactory`, which is V4's
  zero-slot case.
- CREATE2 factory: `moduleAddress` equals the deployed proxy for both create entry points; a second
  create returns the same address and emits no `ModuleCreated`; a stranger naming a safe that already
  has a module gets the gate's revert, not the idempotent return; a safe created before
  `setImplementation` still reports its own module from `moduleAddress`, while
  `moduleAddressForVersion(1)` answers the address of that generation.
- Module index: a module this factory deployed is accepted for the safe that created it (the
  `factory()` branch); a proxy over the real V3 and one over the real V2 are accepted when their
  implementation is in the legacy set and they answer `safe()` with the safe being registered; a proxy
  over an implementation in neither set is refused `ModuleNotRecognised`; a module minted for another
  safe, a bare implementation address and a contract that answers no `safe()` are refused
  `SafeMismatch`; a caller that is not the protocol safe, including the publication's own Safe, is
  refused `OnlyProtocolSafe`; a second, different module for one safe reverts `AlreadyRegistered`; the
  same module again is a quiet no-op with no event; a create by the publication before the protocol
  registers does not take the adopted entry, and `moduleAddress` answers the adopted module while a
  later `createModule` returns it with no deploy and no `ModuleCreated`; the constructor refuses a
  legacy implementation without code, a zero one, and one that answers `factory()`.
- Teardown: `disableModule` ordering against a 3-module list; `deleteRecord` suppressed when the name is
  unknown.

## What is not verified

- That deployed bytecode matches this source, and that any live publication's module is the
  implementation the factory records last.
- Whether any live publication is N-of-N, or has ever been through route B.
- Which modules a live publication actually has enabled — the app's own view of this was not read.
