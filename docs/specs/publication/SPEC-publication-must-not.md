# SPEC-publication-must-not — what the publication area must never allow

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-agreements](SPEC-publication-agreements.md) (the state machine these
> rows protect), [SPEC-publication-review](SPEC-publication-review.md) (the read gate),
> [SPEC-gates](../gates/SPEC-gates.md) (why a gate is fixed in advance).
>
> **Type:** checklist. Each row is one impossible state, the mechanism that makes it impossible, and
> the receipt. A row opens with a bold slug, not a number: no `INV-` is minted here, and no requirement
> id is extended. Where a row derives from a requirement, it names the existing one.
>
> **Audited against live code:** 2026-11-15 (`S2SPublicationModuleV5.sol` on
> `agent/v5-immutable-factory`, and `S2SPublicationModuleV4.sol`,
> `S2SPublicationModuleV4Create2Factory.sol`, both read on `agent/c2-v4-contracts` at `0fb1f71`,
> including the `factory()` capability check that guards the approved set; and the reader-side check of
> the same pass, the `factory()` probes in `shared/src/authoring/publication.ts`,
> `shared/src/protocol/index.ts`, `publication/safe-app/src/lib/publication-init.ts` and
> `author/neutralpress/src/publication/publication.service.ts`). The 2026-11-10 pass read
> `S2SPublicationModuleV3.sol`, `S2SPublicationModuleV3Factory.sol`, `shared/src/gates/index.ts`,
> `press/actions/src/libs/decrypt.ts`, `publication/safe-app/src/lib/publication-version.ts`. The
> CREATE2 factory was added on 2026-11-13 as `S2SPublicationModuleV3Create2Factory.sol` and renamed to
> the V4 factory on 2026-11-14, deploying `S2SPublicationModuleV4`. The CREATE2 factory is deployed,
> with the legacy set its constructor froze, and so is V4: that constructor refuses an implementation
> which is codeless or does not answer `factory()`, so its first implementation is a deployed V4, and
> `isApprovedImplementation[V4]` is set by that constructor and never cleared. V5 is deployed nowhere;
> a deployed V5 is not approved until the protocol safe runs `setImplementation`, so a V5 in the
> approved set is a fact about the chain, not about this tree. Nothing in this file's upgrade rows has
> run against a live V5 instance.
>
> **Test coverage:** 81 pass in `publication/contracts/test/`: 39 in
> `S2SPublicationModuleV4Create2Factory.test.ts`, 16 in `S2SPublicationModuleV3Factory.test.ts`, 9 in
> `S2SPublicationModuleV4.test.ts`, 13 in `S2SPublicationModuleV5.test.ts`, and 4 in
> `implementation-gate.test.ts`, which covers the gate check the factory makes on what it approves. At
> the 2026-11-10 pass the module had no unit test in this tree.
> Rows that cite a code line and no test name are unproven by a suite, and say so. A row marked
> `[GAP]` is a claim the code does not enforce.

---

The area has one hazard worth a file of its own. Under V2, `_append` accepted `author == safe` on the
later-version path, so one `makeOffer` from an untrusted address plus the safe's append right was
enough to write a version onto that address's genesis — publishing under a byline that had done nothing.
V3 removes that right, and these rows are everything else of the same shape: a party able to reach a
state where the record and the byline disagree.

Each row is a MUST NOT, stated against the mechanism. Cites are to
`src/publication/contracts/src/S2SPublicationModuleV3.sol` unless a path is given; V4 keeps that
surface and adds the `factory()` getter and two errors, but the two files are not line-aligned, so a
row whose behaviour is V4's names the file and not a line.

## Ending

**`retract-is-author-only`** — Only the genesis author may end a publication's right to a manuscript;
the publication safe and every stranger are refused. An end that the publication can perform is a
withdrawal of a byline it agreed to carry.
Mechanism: `retract` reverts `NotAuthorized()` when `msg.sender != genesisAuthor[genesis]`, and is the
only write to `_ended` (`:259`, `:263`). Evidence: `:258-269`; no test.

**`end-is-final`** — Once `_ended[genesis]` is true there is no path back on that genesis: the
publication cannot re-strike the manuscript and the author cannot re-offer it. Returning means a new
genesis.
Mechanism: `makeOffer` (`:217`) and `admit` (`:241`) revert `Ended()`; nothing assigns `false` to
`_ended`. Evidence: code only; no test.
Note: an end is set only when there was an agreement to end. Retracting a bare offer writes no flag
(`:262-268`), so a withdrawn offer is re-openable by a later `makeOffer`. Terminality belongs to the
agreement, not to the act of withdrawing.

**`reject-never-freezes`** — A publication can never freeze a genesis. Declining is reversible by
definition, so a publication cannot lock an author out of its own queue.
Mechanism: `reject` never writes `_ended`; it demotes an agreement into the offer set (`:281-284`) or
declines an offer (`:286`), and `admit` stays open while the author may `makeOffer` again.
Evidence: `:277-289`; no test.

**`end-is-not-delete`** — An end is not a delete. The version log stays readable; the text does not.
A record the ending party can erase is not a record (PUBLICATION-11).
Mechanism: `getVersion` (`:391`) and `getVersionCount` (`:396`) are ungated and ignore `_ended`;
`canRead` (`:297-307`) and `canReview` (`:309-312`) require `_isAgreement || _isOffer`, which `retract`
cleared. `retract` makes exactly two writes: the flag, and the tombstone on the latest version
(`:263-264`). The tombstone marks the version and removes nothing. Evidence: code only.

## Admission

**`only-safe-admits`** — Only the publication safe admits or declines. Admission is the publication's
act alone; no author can let themselves in.
Mechanism: `admit` and `reject` are `onlySafe` (`:240`, `:277`); `acceptOffer` is a deprecated alias
that goes through `admit` and carries the same modifier (`:249`). Evidence: `onlySafe` reverts
`OnlySafe()` at `:155-157`; the app binds the verb per module version
(`src/publication/safe-app/src/lib/publication-version.ts:35`), tested in
`src/publication/safe-app/tests/lib/publication-version.test.ts` — "binds V3 to admit/reject with the
V3 ABI".

**`no-self-made-offer`** — A publication can never create the offer it then accepts. If it could, an
admission would be a formality over a version the safe itself wrote.
Mechanism: `makeOffer` from the safe onto a genesis another address wrote reverts `NotGenesisAuthor()`
in `_append` (`:519`); `admit` requires a live offer (`:242`). Evidence: code only.

**`offer-on-anothers-behalf`** — Nobody can offer on another author's behalf. The byline of a genesis
is always the address that wrote its first version, so a work can never be entered under a name its
writer does not hold.
Mechanism: genesis author is always the writer. `_append` sets `genesisAuthor[genesis] = author` from
`msg.sender` on the first version and refuses every later writer (`:512-519`). No caller supplies an
author argument. Evidence: `:508-520`; no test.
Note: the first version is deliberately ungated, so an unvetted author can leave a pending offer
instead of reverting (`:512-516`). The consequence is that authorship is not the same question as
entitlement: any address may create a genesis in its own name, and whether that genesis becomes an
agreement is `makeOffer`'s second step. V2 made the same choice, with the `canPublish` check
commented out (`S2SPublicationModuleV2.sol:352`).

## Byline

**`append-only-by-genesis-author`** — A version is only ever appended by its genesis author, the
publication safe included.
Mechanism: `_append` reverts `NotGenesisAuthor()` on the later-version path when
`author != genesisAuthor[genesis]` (`:519`), with no safe exemption. V2's `_append` allowed
`author == safe` (`S2SPublicationModuleV2.sol:355`); that line is the hole this row closes.
Evidence: `:516-520`; no test.

**`genesis-author-fixed`** — `genesisAuthor` is written once per genesis and never changes. A byline
nobody can reassign is what makes the log a record.
Mechanism: the only assignment is `:515`, reached only when `genesisAuthor[genesis] == address(0)`;
the mapping is private with no setter (`:93`). Evidence: single write, code only.

## Publish rights

**`agreement-grants-no-publish-right`** — An agreement never grants module-level publish rights. If
holding one let an address write, the whitelist would be decorative.
Mechanism: `canPublish` (`:410-415`) is the whitelist predicate — safe, whitelisted dev, whitelisted
author — and reads nothing else; `agreementsHeldBy` / `ownerHasAgreement` (`:328-330`) are maintained
inside `_addAgreement` / `_removeAgreement` (`:543`, `:560`) and feed no gate. Evidence: code only;
the separation is stated in the contract header (`:44-50`).

**`canpublish-is-not-a-read-gate`** — `canPublish` is not a read gate, not a render right, and not
per-manuscript.
Mechanism: the signature is `canPublish(address _address) view returns (bool)` (`:410`) — an address,
not a genesis, so it cannot answer a question about one manuscript. Reading is `canRead(genesis,
reader)`, review is `canReview(genesis, who)`, and neither calls `canPublish`.
Evidence: `:410-415`, `:297-312`; code only. The shape invites the mistake, so it is a row.

## Factory

The rows below are stated against `S2SPublicationModuleV3Factory`, whose file and lines they cite.
`S2SPublicationModuleV4Create2Factory` is the generation that ships: a copy of the same surface, not a
subclass, so it **re-implements** `implementation-by-protocol-safe-only` and
`no-module-for-another-safe` in its own file rather than inheriting them, and each row carries a
second receipt. `upgrade-only-by-own-safe` is no longer inherited unchanged: the `onlySafe` half lives
in the module and V4 extends it with the factory's approval, so its receipt is the module's and the
factory's together. The V3 factory deploys V3. The V4 implementation is deployed against the CREATE2
factory alone, whose constructor and `setImplementation` refuse an implementation that does not answer
`factory()`, so no supported path pairs V4 code with the plain-CREATE factory.

`S2SPublicationModuleV5` changes where the module reads that factory, not the factory itself. The
CREATE2 factory is unchanged and is still the one V4 is deployed against, and the one a V5
implementation is deployed against when the protocol deploys one. V4
recorded the factory in its last storage slot, written by `initialize`; V5 takes it as an immutable
constructor argument and keeps no slot. The rows below are about the factory, so they hold for both;
`upgrade-only-by-own-safe` and `no-stranded-v2-or-v3-publication` are where the difference lands. The
CREATE2 deployment
adds no state to the safe and weakens nothing here; it does mean a module
exists at its predicted address before it is enabled, so `safeModules` and the safe's own module list
can disagree for a while — the safe's list stays the record.

**`implementation-by-protocol-safe-only`** — The implementation can only be set by the protocol safe.
`latestImplementation` decides the logic of every module created afterwards, so a permissionless
setter is a takeover of every future publication.
Mechanism: `protocolSafe` is immutable (`S2SPublicationModuleV3Factory.sol:32`); `setImplementation`
is `onlyProtocolSafe` (`:74`); the constructor refuses a zero or codeless protocol safe (`:58-62`).
Evidence: `S2SPublicationModuleV3Factory.test.ts` — "reverts for a caller that is not the protocol
safe", "refuses an EOA as the protocol safe", "refuses a zero protocol safe".
Re-implemented in `S2SPublicationModuleV4Create2Factory.sol`: its own immutable `protocolSafe`, its own
`onlyProtocolSafe` setter, the same four constructor checks, and the gate check V4 adds. Evidence:
`S2SPublicationModuleV4Create2Factory.test.ts` — "refuses a zero protocol safe", "refuses a protocol
safe without code", "refuses a zero implementation", "refuses an implementation without code",
"refuses setImplementation from a caller that is not the protocol safe".

**`no-module-for-another-safe`** — No third party can mint a module that names another publication's
safe. A spoofed module would enter that safe's module list and be indistinguishable from a real one.
Mechanism: `createModule` reverts `NotSafeOrProtocolSafe` unless the caller is the safe it names or the
protocol safe (`:92-95`). Evidence: `S2SPublicationModuleV3Factory.test.ts` — "reverts for a third
party naming another safe", "reverts for a third party calling createModuleEmpty".
Re-implemented in `S2SPublicationModuleV4Create2Factory.sol`, and the gate is checked **before** the
idempotent return: a stranger naming a safe that already has a module is refused, not handed that
module. Evidence: `S2SPublicationModuleV4Create2Factory.test.ts` — "reverts for a stranger naming
somebody else's safe", "reverts for a stranger calling createModuleEmpty", "reverts for a stranger
naming a safe that already has a module".

**`upgrade-only-by-own-safe`** — A module upgrades only by its own safe, and only to an implementation
the factory has approved. Otherwise one publication could replace the logic running under another's
address, or the publication's holders could adopt code the protocol never set for them.
Mechanism: `_authorizeUpgrade` is `onlySafe`, then requires
`isApprovedImplementation(newImplementation)` from the factory in the module's immutable `FACTORY`,
which the constructor sets and nothing writes afterwards, and reverts
`ImplementationNotApproved(address)` when it answers false. The approved set is the factory's
`implementationHistory`, appended by its constructor and by `setImplementation`, so an earlier
protocol-set implementation stays a legal target and rollback works. A protocol-set implementation
cannot hand the gate back to the publication: the factory refuses an implementation that does not
answer `factory()` with `ImplementationWithoutUpgradeGate(address)`, in the constructor and in
`setImplementation`, so the set holds nothing whose `_authorizeUpgrade` is the publication-safe check
alone. V5's constructor refuses a factory with no code, `InvalidFactory(address)`: the address is
fixed for the life of the implementation, so a wrong one would refuse every upgrade on every proxy
over it and no later call could correct it. V4 kept the same address in a slot written by
`initialize` and reverted `NoFactory()` when the slot was zero, which is the state of every proxy
upgraded to V4 in place, since `initialize` does not run again; V5 drops that slot and that error, and
the layout below the removed slot is untouched. Slot 119 itself is reused for one bool that guards the
V2 backfill, which `initialize` sets and `reinitializeV3` requires false: the backfill increments, so a
second pass would double a count `_addAgreement` already made, and `_removeAgreement` floors at zero,
leaving `ownerHasAgreement` true for an author holding nothing.
Evidence: `_authorizeUpgrade` is `onlySafe` in `S2SPublicationModuleV5.sol`, unchanged from
`S2SPublicationModuleV3.sol:197`; the approval half is V4's, and `S2SPublicationModuleV4.test.ts` still
covers it on V4 — "lets the safe upgrade to an implementation the factory has set", "refuses an
implementation the factory never set", "refuses an upgrade started by anyone but the safe", "refuses
every upgrade once it runs V4 without a factory recorded", "keeps version 1 legal after
setImplementation, so a module can roll back". `S2SPublicationModuleV5.test.ts` covers V5 —
"lets the safe upgrade to an implementation the factory has set", "refuses an implementation the
immutable factory never set", "refuses an upgrade started by anyone but the safe", "refuses a factory
with no code, which no later call could correct", "refuses a protocol safe the factory does not name",
"keeps answering the same factory after the proxy is upgraded", "leaves no storage slot holding the
factory, unlike V4", and "matches V4 slot for slot, and leaves the factory slot empty", which reads
each module's compiled `storageLayout` and compares it against the other's. The gate check on the set is
`S2SPublicationModuleV4Create2Factory.test.ts` — "refuses an implementation that carries no upgrade
gate", "refuses setImplementation of an implementation that carries no upgrade gate".

**`no-stranded-v2-or-v3-publication`** — A publication still running V2 or V3 is never left unable to
reach the current implementation. The right to upgrade is its own safe's, and it must not depend on a
record the factory froze before that publication was considered.
Mechanism: V2 and V3 authorise an upgrade with `onlySafe` alone, so a proxy running either reaches V5
in one hop, with no factory approval and no legacy registration on the way in —
`S2SPublicationModuleV5`'s own check runs on the hop after that. The factory a proxy adopts is the
immutable, so a proxy born under a plain-CREATE factory answers the CREATE2 factory's approval set
from its first V5 block, which is what the two live V2 publications on Base need: they run an
implementation the deployed factory's legacy set does not name, so `registerModule` cannot adopt them,
and `createModule` cannot either, and without this hop they would be stuck on V2 forever.

A proxy already on V4 is outside this row and is stranded for good. The right to upgrade is checked by
the code being replaced, and V4's check reads a `factory` slot that `initialize` wrote only on a
proxy the factory itself created: on an upgraded proxy the slot is zero, so `_authorizeUpgrade` reverts
`NoFactory()` before any payload runs, and no implementation, V5 included, can move it. Registering it
is closed as well, because it is already registered or because the factory cannot adopt a publication
whose genesis it does not hold — `registerModule` records an implementation, it does not replace the
upgrade check. V5 exists so that V2 and V3 proxies never join it. The payload
is `reinitializeV3()`, which backfills `agreementsHeldBy` once and reverts on a proxy whose nonce 2 is
spent or whose slot 119 sentinel says the counts are already right; `upgradeToAndCall` with `0x` is not
an option on any version here, because OZ 4.9 force-calls the implementation and no module in the tree
has a `receive` or `fallback`. `scripts/upgrade-publication.ts` derives which payload applies from the
proxy's own implementation, `NAME()` and nonce, and refuses a V4 target by name: V4 is permanently
approved, a V2 proxy's `onlySafe` would accept it, and the spend is unrecoverable.
Evidence: `S2SPublicationModuleV5.test.ts` — "keeps agreements, offers and whitelists across the jump",
"backfills agreementsHeldBy exactly once" (the counter slot holds 2 for two agreements, not 4, and a
second payload reverts), "refuses the backfill on a proxy whose counts are already right", and
"answers the factory it was constructed with, through the proxy".

## Reading

**`read-while-offered-or-agreed`** — Reviewers read while a work is offered or agreed, never after the
author ends it, and never for a genesis that does not exist (GATES-2, GATES-6).
Mechanism: `canRead` (`:297-307`) and `canReview` (`:309-312`) return false unless
`_isAgreement || _isOffer`; an unknown genesis is false at `:298`. Evidence: code only.

**`canread-trusts-the-address`** — `canRead(genesis, reader)` MUST be paired with
`isOwner(reader, signer)` by its caller. The module can be handed a reader; it cannot check that the
reader holds the Safe it names.
Mechanism: the contract takes `reader` as given (`:297`) and has no way to reach `safe.isOwner` for an
arbitrary address in one call, so a correct on-chain answer is not the whole answer. The pairing is a
caller obligation, and the caller in this tree does perform it: `src/shared/src/gates/index.ts:94-105`
ANDs the `isOwner` read into the same predicate, reached from
`src/press/actions/src/libs/decrypt.ts:38`. Evidence: the shape is visible in the signature; nothing in
this tree calls the module's own `canRead`, so the obligation is unexercised for that entry point.
Note: this is the one place where a correct on-chain answer is not the whole answer, and the reason
this document exists in this shape.

**`press-read-gate-composes-its-own`** `[GAP]` — The press does not call the module's gates on the
decrypt path. `src/shared/src/gates/index.ts:94-105` composes `canPublish(safeAddress) &&
isOwner(signerAddress) && hasDeal(genesis)`, so an offer-stage read is refused there by both term 1 and
term 3 even though the module's `canRead` would admit the safe, the author and a reviewer.
Offer-stage reviewers are meant to go through `canReview` (`src/press/actions/src/libs/gates.ts:49`),
which asks the module and returns `reviewers[who] && (agreement || offer)`; nothing in this tree calls
it, and the app has no reviewer surface. So a reviewer cannot decrypt through the deployed press path
at all: the composed gate asks for an owner of the author Safe, and a reviewer is not one. Recorded as
a gap, not fixed here. Evidence:
`src/shared/src/gates/index.ts:94-105`, with tests in `src/shared/src/gates/index.test.ts` — "reads
canPublish on the publication, isOwner on the author Safe, hasDeal on the publication".

## Nobody

**`nothing-is-deleted`** — No party deletes a version, rewrites a log entry, or reorders the record to
hide one. The only mutations are a `push` in `_append` and `tombstone = true` in `retract`
(`:522-530`, `:264`); no function pops, overwrites or clears `versions[genesis]`.
The agreement and offer sets are a different matter: they are swap-popped, so an entry changes position
without anything being removed, and a snapshot taken across a removal can miss or double-count. That
is [the sets are enumerable, unordered, and swap-popped](SPEC-publication-agreements.md#the-sets-are-enumerable-unordered-and-swap-popped),
not a deletion. Evidence: `:546-580`; code only.
Note: "no party changes a manuscript's gates after encryption" (GATES-5) is not enforced by anything in
this worktree. The contract stores a CID and a tombstone flag, not a condition set; whether the sealed
ciphertext fixes the gates is still open in [SPEC-gates](../gates/SPEC-gates.md#not-yet-established).
