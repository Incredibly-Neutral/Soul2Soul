# specs

What must hold, and what this implementation made of it. One folder per domain,
mirroring the paper's chapters (`~/code/polyphony/whitepaper/`) and `docs/prototype/` by filename.

Each domain folder has a **twin** — `SPEC-<domain>.md` — and, where the detail
has grown, **branches** beside it. The twin is the document to read: the
invariants first, then an index of the records and the branches.

The invariant half is implementation-agnostic: **if an invariant names a product
— Safe, Lit, ENS, Base, Filecoin — it is in the wrong layer.** The protocol does
not know what this implementation is made of. Everything under "This
implementation" is the opposite: it names the packages, the contracts and the
choices, because that is where a gap or an addition is visible.

```
docs/specs/
  README.md                        this file
  SUMMARY.md                       the whole protocol in one read, for orientation
  system/                          SPEC-system-contract.md, SPEC-shared.md
  author/         SPEC-author.md + SPEC-author-overview.md + 10 branches
  publication/    SPEC-publication.md + SPEC-publication-overview.md + 8 branches
  agreement/      SPEC-agreement.md
  gates/          SPEC-gates.md
  press/          SPEC-press.md + SPEC-protocol-actions.md
  monetization/   SPEC-monetization.md
  reader/         SPEC-reader.md
  adr/  rfc/                       are at docs/, not here — see Records
```

## Layers

| layer | question | register | authority |
|---|---|---|---|
| the paper (`~/code/polyphony/whitepaper/`, separate repo) | why, and what for | argument, for a reader | intent |
| `docs/specs/` | what must hold, and what this build chose | invariants, then decisions/proposals/gaps | **the protocol**, then this implementation |
| `docs/prototype/` | what this implementation is, told plainly | prose, for a reader | this implementation |
| `docs/research/`, `docs/audits/` | what we found out, and when | dated notes, immutable | evidence — never authority |
| code | how it is done | mechanism | itself |

`docs/prototype/<domain>.md` and the twin read as the same three lists:
**decisions already made** (ADRs), **changes proposed** (RFCs), and **gaps with
no fix described** (no RFC). The twin puts the invariants above them, so a
reader can see what is owed before seeing what was done.

A fourth list belongs only to the twin: **additions** — things this
implementation does that the protocol does not require. They are recorded so they
are not mistaken for guarantees, and they are kept out of the paper: a reader of
the paper should not find a capability the protocol never promised.

An implementation may do less than the protocol (a gap) or more than it (an
addition). Neither changes the protocol. Coverage is not conformance: the
protocol is what the invariant says, never what the code happens to do.

## Claims

Each invariant carries an ID: `<DOMAIN>-<n>`, domains `AUTHOR`, `PUBLICATION`,
`AGREEMENT`, `GATES`, `PRESS`, `MONETIZATION`, `READER`. The first four are the
parties — author, publication, press, reader; the rest are the relation, the
condition, and the cost. Numbers follow the paper's order so the two files read
side by side, but the IDs belong to this layer — rewriting or reordering the
paper does not re-point them.

One sentence in `MUST` / `MUST NOT` / `MAY`, then only what the requirement
needs in order to have a boundary. No status, no code path, no judgement.

## Records

- `docs/adr/ADR-<n>-<slug>.md` — decided, with the alternative it beat and its cost
- `docs/rfc/RFC-<n>-<slug>.md` — proposed, with the invariant it would satisfy
- Numbers are permanent, and there is **one namespace** for each. Withdrawn
  records keep their number and say so. Every record names its domain in a
  header line; the twin for that domain indexes it.

## Branches

A domain whose detail is spread across packages gets branches beside its twin:

```
docs/specs/<domain>/SPEC-<domain>.md            the twin — invariants + record/branch index
docs/specs/<domain>/SPEC-<domain>-overview.md   the model across the parts: host matrix, reading order, drift
docs/specs/<domain>/SPEC-<domain>-<part>.md     one file per package or host; authoritative for its own area
```

The twin and the overview never re-state a part's detail; each part names its
parent in its header blockquote, and where they disagree the part wins for its
own area.

## Index

- `system/SPEC-system-contract.md` — the topology, the invariant register, the gap register, the
  per-component spec template, the working environment
- `system/SPEC-shared.md` — types, validation, the render orchestration, `cid-view`
- `SUMMARY.md` — the protocol and the pipeline end to end, enough to write a proposal without
  re-reading everything
- `author/` — nine invariants, ADR-001..003, RFC-001..002, RFC-003, RFC-004; branches:
  `identity`, `publishing`, `shared`, `hosts`, `cli`, `nvim`, `vscode`, `nvim-s2s`, `drafts`,
  `owner-history` (who was an owner of the author Safe, and when — the module, the guard and
  the era model)
- `publication/` — thirteen invariants, two additions, five gaps; branches: `account`,
  `agreements`, `admin-app`, `look`, `review`, `must-not` (the impossible states of the area, with
  the mechanism and the receipt for each), `storage`, `contracts-ens` (the name layer, which
  implements PUBLICATION-1, -8 and -9)
- `agreement/` — seven invariants, two additions, four gaps; the agreement is a boolean per
  manuscript, not an object (`S2SPublicationModuleV2`), and its detail is the
  `publication/SPEC-publication-agreements.md` branch
- `gates/` — eight invariants, one addition (tree reset), one gap (GATES-4's author caller);
  no branch — the gates are `src/shared/src/gates`
- `press/` — nine invariants, six additions, two gaps (PRESS-7's re-encryption, PRESS-6's config
  choice); the only place plaintext is held; branch: `SPEC-protocol-actions.md` (PREP → RENDER →
  UPDATE)
- `monetization/` — four payment invariants and the cost split; none of the three rails is built,
  so the domain is recorded as absent rather than partial
- `reader/` — four invariants, three additions, four gaps; the domain holds a CCIP-read relay and
  no verifier, so every check the paper promises is unbuilt

## Historical

The tree was `docs/protocol/` while it was still one flat file per domain, and before that the
component specs lived in `brain/specs/`. `brain/` is retired; the specs, the research, the audits
and the code map were moved here on 2026-11-04, and the transition is noted in
`docs/conventions.md`. Old → new paths inside branches are kept as history, not as live links.
