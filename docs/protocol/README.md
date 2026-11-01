# protocol text

The protocol, stated as invariants. One file per domain, mirroring
`docs/whitepaper/` by filename. Implementation-agnostic: **if an invariant names
a product — Safe, Lit, ENS, Base, Filecoin — it is in the wrong layer.** The
protocol does not know what this implementation is made of.

## Layers

| layer | question | register | authority |
|---|---|---|---|
| `docs/whitepaper/` | why, and what for | argument, for a reader | intent |
| `docs/protocol/` | what must hold | invariants, for any implementation | **the protocol** |
| `docs/prototype/` | what this implementation chose and what it lacks | decisions, proposals, gaps | this implementation |
| `docs/research/` | what we found out, and when | dated notes, immutable | evidence — never authority |
| code | how it is done | mechanism | itself |

`docs/prototype/<domain>.md` is the in-between layer, and it reads as three
lists: **decisions already made** (ADRs), **changes proposed** (RFCs), and
**gaps with no fix described** (no RFC). The protocol file mirrors that shape —
invariants first, then an index of the same three, linking to the records below.

A fourth list belongs only to the protocol file: **additions** — things this
implementation does that the protocol does not require. They are recorded so they
are not mistaken for guarantees, and they are deliberately kept out of the public
docs: a reader of the paper should not find a capability the protocol never
promised.

An implementation may do less than the protocol (a gap) or more than it (an
addition). Neither changes the protocol. Coverage is not conformance: the
protocol is what the invariant says, never what the code happens to do.

## Claims

Each invariant carries an ID: `<DOMAIN>-<n>`, domains `AUTHOR`, `PUBLICATION`,
`AGREEMENT`, `GATES`, `PRESS`, `MONETIZATION`, `READER`. The first four are the
parties — author, publication, press, reader; the rest are the relation, the
condition, and the cost. Numbers follow the
paper's order so the two files read side by side, but the IDs belong to this
layer — rewriting or reordering the paper does not re-point them.

One sentence in `MUST` / `MUST NOT` / `MAY`, then only what the requirement
needs in order to have a boundary. No status, no code path, no judgement.

## Records

- `docs/adr/ADR-<n>-<slug>.md` — decided, with the alternative it beat and its cost
- `docs/rfc/RFC-<n>-<slug>.md` — proposed, with the invariant it would satisfy
- Numbers are permanent. Withdrawn records keep their number and say so.

## Files

- `docs/research/` — dated "as of" reports; superseded claims stay in the file, superseded
  designs are struck by the RFC that replaces them
- `author.md` — the nine author invariants, ADR-001..002, RFC-001..002
- `publication.md` — the thirteen publication invariants, two additions, five gaps;
  the name layer (`src/publication/ens-contracts`) implements PUBLICATION-1, -8 and -9
- `agreement.md` — the seven agreement invariants, two additions, four gaps; the agreement
  is a boolean per manuscript, not an object (`S2SPublicationModuleV2`)
- `gates.md` — the eight gate invariants, one addition (tree reset), one gap (GATES-4's
  author caller)
- `press.md` — the nine press invariants, six additions, two gaps (PRESS-7's re-encryption,
  PRESS-6's config choice); the only place plaintext is held
- `monetization-and-costs.md` — the four payment invariants and the cost split; none of the
  three rails is built, so the domain is recorded as absent rather than partial
- `reader.md` — the four reader invariants, three additions, four gaps; the domain holds a
  CCIP-read relay and no verifier, so every check the paper promises is unbuilt
