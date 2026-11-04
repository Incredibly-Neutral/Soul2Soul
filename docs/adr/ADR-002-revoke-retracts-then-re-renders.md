# ADR-002 — revoking retracts on-chain first, then re-renders with a remove directive

Status: accepted · Domain: AUTHOR · Satisfies: AUTHOR-3

## Context

AUTHOR-3 asks for two things, and the second is the one that is easy to skip:
the right to publish must end *and* the work must come off the site under the
publication's name, by the author's action, without the publication's cooperation.
An entry that only ends the agreement leaves the page standing until someone
rebuilds — which is exactly the state the paper says an author must never be in.

## Decision

One command, two steps, in this order:

1. The author's account calls `retract(genesis)` on the publication's module,
   which withdraws that version from deals and from offers. Authorised as the
   author, so the publication is not consulted and cannot refuse.
2. The same render-publish path that publishing uses runs again with a remove
   directive for the revoked path — render enabled, publish enabled, offer
   disabled — so the tree is rebuilt without the work and the name's record is
   updated to the new root.

Retract precedes the rebuild deliberately: a rebuild that raced the retract could
re-render the work it is meant to remove.

## Alternatives rejected

- **Delete the record and stop.** Fails AUTHOR-3: the page stays up under the
  publication's name until someone else rebuilds.
- **Wait for the publication to rebuild.** Fails the same clause — the author's
  exit would depend on the counterparty's goodwill.
- **Rebuild the whole site from scratch.** Correct but expensive; the remove
  directive gets the same root for the cost of one page's worth of work.
- **Have the author sign the record update.** Would put the name's record under the
  author's key and break VERIFICATION-1, where only the press changes it.

## Consequences

- The author, acting alone, can change what a publication's name resolves to — by
  subtraction only. The press still signs the update; the author only causes it.
  This is the permission model in one line and it is worth restating in
  `press.md`.
- Revocation is not a deletion. The retracted version is still recorded, and the
  rebuild is what removes it from the current site; copies elsewhere are untouched.
- A revoked path is removed by path, so the invariant is only as good as the
  path mapping: a locale or slug change that leaves the old path in the tree would
  keep the page resolvable. Re-check when `publication.md` fixes path derivation.
- **Step 2 is authorised by the wrong gate.** `canPublish` asks whether the
  publication trusts the caller — publication Safe, whitelisted devs, whitelisted
  authors — not whether the caller authored this manuscript. Since
  `removeWhitelistedAuthor` is unconditional and publication-only, an author who
  has been de-whitelisted can still retract on the ledger but cannot get the page
  rebuilt away. This decision is therefore satisfied in practice and not in
  principle; the gap is recorded in `docs/specs/author/SPEC-author.md`, and the missing gate
  belongs in `gates.md`.
