# READER — checking a page without trusting who serves it

Read against: `whitepaper/verification.md` (2026-10-29).

A reader follows a chain of authorisation from a publication's name to the page in front of them.
The name's record holds the content address of the site's root; the root addresses every page; the
page carries a colophon signed by the press that points at the manuscript, which carries the
author's own signature, and at the agreement on the ledger. Each link vouches for the next, and the
first link is what makes the last one current.

The domain's four requirements are therefore not features the implementation provides but checks it
must leave open. Nothing here needs a server: all four read the ledger and the page.

Note: this chapter's name in the paper is Verification, and its subject is the reader. The domain is
READER, and the protocol text mirrors the paper under `verification.md`.

## READER-1 — see every change to the name's record

An implementation MUST let any reader see every change to the name's record, including when it
changed and to what.

Note: "every change" is a history, not a current value. A record that only reports where the name
points now does not satisfy this.

## READER-2 — check any page against the root the name points to

An implementation MUST let any reader take a page, take the root the name's record points to, and
check that the page belongs to that root — without trusting the host that served either.

Note: the requirement covers the whole path from name to root as well, not only the page-to-root
step. A root that a reader can only obtain from a host it must trust is a root it has not checked.

## READER-3 — check the colophon's signature

An implementation MUST let any reader check that the colophon on a page was signed by the press,
and that the colophon's hash matches the page it is on.

## READER-4 — trace the page to the author's signature and to the agreement

An implementation MUST let any reader follow the colophon to the manuscript the page was built
from, to that manuscript's author signature, and to the agreement under which it was built — and
check that all three agree.

Note: "agree" means the author the manuscript names is the author the agreement records, and the
manuscript the agreement covers is the one the page carries. Following the pointers without
comparing them proves nothing.

---

# This implementation

Read against `src/reader/`, `src/shared/src/cid-view`, `src/press/actions/src/update/verify.ts`,
`src/publication/ens-contracts`.

The domain holds one package: a CCIP-read gateway that answers a name resolution by relaying the
corresponding call to the chain the records live on. It is a relay — it decodes an `(address, bytes)`
pair, calls that address with that data, and returns the result. It makes no decision and checks no
signature, and it will relay any call it is handed, not only its own publication's.

Everything else a reader needs lives outside this folder, and mostly inside the press.

## Readings

- **READER-4's "trace"** is three reads that the page's own data lines up with: `authorOf(genesis)`
  on the publication module, `hasDeal(genesis)` for the agreement, and the manuscript's proof. The
  ingredients are on the page and on the ledger; there is no fourth thing to fetch.
- **Currency** is decided by the name alone. A page from an older build can carry a valid press
  signature and a valid author proof and still not be what the name points to — which is the reason
  READER-2 comes before READER-3 in practice.
- **The gateway is not part of the chain of authorisation.** It serves READER-1 and READER-2 by
  making the chain readable; it is not a link in it.

## Additions

- **Canonicalisation versions.** Older pages signed a skeleton under one canonicalisation and newer
  pages sign the page under another; the colophon records which, so a page built by either can still
  be checked. The protocol says pages carry a signature; it does not say signatures must survive a
  change of scheme.
- **Retrievability checking.** A reader-facing helper asks independent IPFS endpoints whether a CID
  can actually be retrieved and reports per-endpoint results. Useful, and not required: PRESS-9
  gives a root, and the protocol does not promise that anyone still holds it.
- **A publication view.** The shared CID-view collectors assemble a publication's config, deals,
  site tree, archive and retrievability into one object. It is the raw material READER-2 and READER-4
  would be built from, and it ships in the safe app for operators, not to readers.

## Gaps without a proposal

- **READER-2 has no verifier, and its first step is unverified where it matters most.** Nothing in
  the tree takes a page and the recorded root and checks membership — the code that reads the tree
  (`shared/src/cid-view/tree.ts`) lists what a root contains; it does not verify a page against it.
  And the resolver that turns the name into a root returns the answer it was handed: its
  `OffchainLookup` callbacks `abi.decode` the HTTP response and return it, with no signature to
  check. So a reader asking through that path trusts whichever gateway the resolver names. The
  record therefore has to be read on the chain that holds it, where the gateway's answer is
  checkable, and no reader tool in this repo does that.
- **READER-3's check exists, but only inside the press.** Before accepting a page the update action
  verifies the page's press signature, that the page has not been tampered with, and that the
  manifest it carries is well formed — exactly what READER-3 asks a reader to be able to do, done by
  the party the reader is supposed to be checking. Nothing exposes it reader-side.
- **READER-4 has no verifier at all.** The pointers are present and the comparisons are specified in
  the note above; no code performs them.
- **There is no serving path.** A service that resolved a publication's name and served the site
  behind it existed in this repository and has been deleted; the tree now contains nothing that
  turns a name into the pages a reader reads. The protocol does not require one — any host that
  speaks the content addressing of PRESS-9 will do — but the implementation no longer offers one,
  so READER-2's "any page" has no first-party route.

## Not yet established

- **Who the reader is, in practice.** The chain to a name only works for a client that follows
  `OffchainLookup` through to a chain the name is not on. Whether ordinary ENS-aware wallets and
  browsers do that, or whether reading through a bespoke tool is the real path, decides how much of
  this chapter any reader will ever exercise — and it is not a question the repository can answer.
