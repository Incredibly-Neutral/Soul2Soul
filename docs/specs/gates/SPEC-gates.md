# GATES — who may decrypt, and who may ask for a build

Read against: `~/code/polyphony/whitepaper/gates.md` (2026-10-29).

No branch: the gates are small enough to read at `src/shared/src/gates`.

A gate is a condition fixed in advance. What it reads from the ledger may change — whether an
agreement is in force, who is a holder — but the gate itself may not. It is checked at the moment
someone asks, before anything is decrypted, and it decides only whether a decryption happens,
never what is done with the plaintext afterwards.

A manuscript is opened in four places: to the author (GATES-1), to a publication's reviewers
(GATES-2), to the renderer (GATES-3), and to readers behind monetization (GATES-7, GATES-8). The
renderer's own right to run is settled separately, by who may ask it (GATES-4). GATES-5 and
GATES-6 are constraints on all of them: gates do not move, and ledger state is read at ask time.

---

## GATES-1 — the author, unconditionally

The author MUST be able to decrypt their own manuscript at any time. No agreement, whitelist or
gate result MAY be required for it.

Note (this implementation): ownership is one gate, `isOwnerAt`, in `src/shared/src/gates`. It takes
the author Safe, the signer and an optional block. With no block, or block 0, it asks the Safe's live
`isOwner`. With a block above 0 it asks the author Safe's `OwnerHistoryModuleV1` whether the signer
was an owner at that block. `canPublish` and `canReset` ask it with no block. `canRead` asks it at the
append block of the manuscript's last version, resolving that block inside the gate from the Safe's
drafts module, and falls back to the live `isOwner` when the Safe's modules cannot be resolved. The
predicates `owns` and `ownsVerdict` are gone: a drafts log naming a Safe for a genesis is a proof the
drafts caller makes, and the ownership half of it is `isOwnerAt`.

The block is what makes a read historical. Where the manuscript's last version carries the block it
was written in — the drafts log's `blocksOf(genesis)`, last entry — `canRead` judges ownership at that
block: a key rotated out still reads what it wrote, and a key added afterwards does not read what it
did not. A block of 0 means none was recorded (a version older than the field, or a log carried in by
`absorb()`), so the gate answers with the live owner set instead. That block is also what bounds the
answer: history starts at the Safe's era 0, and an owner rotation the guard missed stretches the
tenure it should have ended.

The drafts decrypt path composes that gate rather than importing one. It resolves the author Safe's
modules from the Safe's enabled-module list, requires its `DraftsModuleV1` to name the Safe for the
genesis, and asks `isOwnerAt` at the append block of the last version. It reads the draft entry at
that block and from the module it resolved, so nothing is resolved twice and the ciphertext it opens
and the owner set it was judged under are one version. It then requires the blob's own signed
`public.author` to equal the Safe: `append` is `onlySafe`, so anyone may log another author's genesis
and ciphertext CID in their own module, and only the blob's signed author refuses that.

## GATES-2 — reviewers, until the offer ends

The reviewers of a publication MUST be able to decrypt a manuscript offered to it, until the
publication declines it or the author withdraws it, and MUST be refused any new decryption after
that.

Note: what was decrypted before the end stays decrypted. The gate governs future decryption, not
memory.

## GATES-3 — the renderer, under an agreement, on the approved version

The renderer MUST be able to decrypt a manuscript only while an agreement covering it is in force,
and only for the version the publication approved.

Note: a revision does not extend an approval (AUTHOR-4), so a newer version is unreadable to the
renderer until a new agreement names it.

## GATES-4 — who may ask for a build

The renderer MUST build and publish a site when asked by: the author of a manuscript the site
carries **or has carried**; a holder of the publication; or someone the holders have authorised.

Note: three callers, and the first survives the end of the agreement — "has carried" is what makes
a withdrawn manuscript still removable by its author. The requirement as stated is an obligation to
serve these callers; it does not by itself exclude others, which is a prose claim in the paper
rather than a numbered one. A request MUST NOT be able to put anything on the site: the renderer
builds only from the agreements in force.

## GATES-5 — gates do not move

A manuscript's gates MUST be immutable once it is encrypted. No party MAY change them. Only the
implementation's governance, by publishing new code, MAY alter what the gates are.

## GATES-6 — the ledger is read when asked

Every gate MUST be checked against the ledger at the moment it is asked, so that an ending or a
withdrawal counts from the moment it is recorded.

## GATES-7 — the reader gate releases text, nothing else

When an agreement includes monetization, the manuscript's text MUST be released only once the
agreed check passes on the ledger. The check answers yes or no and MUST NOT hold the money.

## GATES-8 — the reader-gate terms last as long as the agreement

Whether, and for how long, a manuscript sits behind the reader gate MUST stay unchanged for the
life of the agreement. Changing it MUST require a new agreement.

---

# This implementation

## Additions

Things this implementation does that the protocol does not require. Recorded here; deliberately
absent from the public docs.

- **Publication-owned tree reset.** A holder of the publication, and only a holder, may clear the
  entire site — a rebuild from an empty rather than from the agreements in force. The protocol
  grants no such power: its only removal is an author withdrawing their own work, and GATES-4
  forbids a request from putting anything on the site, not from emptying it. This is a property
  right over the publication's own site, not a protocol guarantee, and it should never be
  presented as one. It also means "a publication cannot keep showing the old site" is a matter of
  what the press will build, not of what a holder can do.

## The update gate, page by page

The update action is gated per page rather than per request. Adding a page, meaning writing a
genesis to a destination path that does not already carry it, requires `canPublish`, which admits
the author Safe and asks `isOwnerAt` of the signer with no block. Refreshing a page, meaning the
destination path already carries that genesis, is ungated. Removing a path is ungated and allowed
only while the page's genesis is out of force, read through the shared `isOutOfForce`. A reset keeps
`canReset` and is unchanged.

The tree is the render of the agreements in force; anything on it that is not that render is drift.
Drift is repaired by the press, not authorised by a caller, so the repair carries no gate.
GATES-4's "has carried" is why an author's own page can be out of force while the press still
carries it, and nothing but a rebuild takes it off.

The effect on a de-listed author: one request completes the takedown, their own page removed and
every page listing it refreshed. Refreshes are unmetered, so an untrusted caller can make the
press re-render pages it already carries, and the output is unchanged because the render is a
function of the ledger.

## Not yet established

- **GATES-5's mechanism.** Whether a manuscript's gates are fixed by the access conditions sealed
  into its ciphertext at encryption, or by the version of the action code at build time, is not
  settled here. The distinction decides what happens when governance publishes new gate code: if
  the conditions are sealed, old manuscripts keep their old gates and the two mechanisms are
  independent; if the code decides, every manuscript's gates move with the code. GATES-5 says gates
  do not move — the implementation has to say which of the two it means.
