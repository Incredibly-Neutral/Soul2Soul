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

## Gaps without a proposal

- **GATES-4, first caller.** The implementation authorises builds with `canPublish(author) &&
  isOwner(signer)`, where `canPublish` covers the second and third callers — the publication and
  the accounts it has authorised — and never asks whether the caller authored the manuscript. The
  author branch is missing, so an author whom the publication has de-authorised can end the
  agreement and cannot cause the rebuild. The on-chain fact that would answer it survives
  revocation. Detailed in `author.md`; the gate itself is unbuilt.

## Not yet established

- **GATES-5's mechanism.** Whether a manuscript's gates are fixed by the access conditions sealed
  into its ciphertext at encryption, or by the version of the action code at build time, is not
  settled here. The distinction decides what happens when governance publishes new gate code: if
  the conditions are sealed, old manuscripts keep their old gates and the two mechanisms are
  independent; if the code decides, every manuscript's gates move with the code. GATES-5 says gates
  do not move — the implementation has to say which of the two it means.
