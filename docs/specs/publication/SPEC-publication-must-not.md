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
> **Audited against live code:** 2026-11-10 (`S2SPublicationModuleV3.sol`,
> `S2SPublicationModuleV3Factory.sol`, `shared/src/gates/index.ts`, `press/actions/src/libs/decrypt.ts`,
> `publication/safe-app/src/lib/publication-version.ts`).
>
> **Test coverage:** the module has no unit test in this tree; only the factory does. Rows that cite a
> code line and no test name are unproven by a suite, and say so. A row marked `[GAP]` is a claim the
> code does not enforce.

---

The area has one hazard worth a file of its own. Under V2, `_append` accepted `author == safe` on the
later-version path, so one `makeOffer` from an untrusted address plus the safe's append right was
enough to write a version onto that address's genesis — publishing under a byline that had done nothing.
V3 removes that right, and these rows are everything else of the same shape: a party able to reach a
state where the record and the byline disagree.

Each row is a MUST NOT, stated against the mechanism. Cites are to
`src/publication/contracts/src/S2SPublicationModuleV3.sol` unless a path is given.

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

**`implementation-by-protocol-safe-only`** — The implementation can only be set by the protocol safe.
`latestImplementation` decides the logic of every module created afterwards, so a permissionless
setter is a takeover of every future publication.
Mechanism: `protocolSafe` is immutable (`S2SPublicationModuleV3Factory.sol:32`); `setImplementation`
is `onlyProtocolSafe` (`:74`); the constructor refuses a zero or codeless protocol safe (`:58-62`).
Evidence: `S2SPublicationModuleV3Factory.test.ts` — "reverts for a caller that is not the protocol
safe", "refuses an EOA as the protocol safe", "refuses a zero protocol safe".

**`no-module-for-another-safe`** — No third party can mint a module that names another publication's
safe. A spoofed module would enter that safe's module list and be indistinguishable from a real one.
Mechanism: `createModule` reverts `NotSafeOrProtocolSafe` unless the caller is the safe it names or the
protocol safe (`:92-95`). Evidence: `S2SPublicationModuleV3Factory.test.ts` — "reverts for a third
party naming another safe", "reverts for a third party calling createModuleEmpty".

**`upgrade-only-by-own-safe`** — A module upgrades only by its own safe. Otherwise one publication
could replace the logic running under another's address.
Mechanism: `_authorizeUpgrade` is `onlySafe` (`:197`). Evidence: code only; no test.

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
