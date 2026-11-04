# docs conventions — the layer rule

> The routing rule that keeps `docs/` honest: **a spec describes behaviour; it does not collect
> the remains of actions.** Working material (acceptance contracts, open confirmations, "must
> adapt" notes, status flags) belongs in an **RFC** or in scratch. A spec only receives the
> *settled outcome* of a change — after it is implemented and independently reviewed.

## The taxonomy

| artifact | where | purpose | lifecycle |
|---|---|---|---|
| **whitepaper** | `docs/whitepaper/<domain>.md` | Why, as argument. What any implementation is for. | Published. Changes when the protocol's intent changes. |
| **twin spec** | `docs/specs/<domain>/SPEC-<domain>.md` | The invariants for that domain, then the record index. Read this before touching code in the domain. | Invariants only change when the protocol changes; the index changes with every record. |
| **branch spec** | `docs/specs/<domain>/SPEC-<domain>-<part>.md` | Settled behaviour of one package or host: the I/O contract, invariants, gotchas, test seams, safe-to-change. | Updated with settled outcomes. |
| **prototype doc** | `docs/prototype/<domain>.md` | What this build chose, in prose, for a reader. Published. | Follows the build. |
| **ADR** | `docs/adr/ADR-<n>-<slug>.md` | A decision already made, with the alternative it beat and what it costs. | Permanent once accepted. |
| **RFC** | `docs/rfc/RFC-<n>-<slug>.md` | A change proposed and not yet built: required behaviour, acceptance contract, open confirmations. | Created on proposal; when built + reviewed, fold the settled part into the spec and strike the RFC. |
| **research / audit** | `docs/research/`, `docs/audits/` | Dated "as of" evidence. | Immutable. Superseded claims stay in the file; superseded designs are struck by the RFC that replaces them. |
| **scratch** | `.work/` — gitignored | Working notes for a task in flight: investigation output, probe results, a per-task pick-up contract if the session needs one. | Deleted freely. Never cited, never durable, per-machine. |

## Routing rule

- **Contract / working material** — acceptance criteria, open confirmations, "must adapt" notes,
  status flags, implementation gotchas → **RFC** if it outlives the task, `.work/` if it does not.
  Never the spec.
- **Description of behaviour** — what the system does (or is required to do) → **spec**: the twin
  for the invariant, the branch for the mechanism.
- **A decision with an alternative** → **ADR**, and index it from the twin.
- **Settled outcome** — after implementation + independent review, fold the now-true behaviour into
  the branch, index the ADR from the twin, and strike the RFC.
- **A review** — the PR is the record: verdict, diff, comments, approval. Where a reviewer's
  reasoning is worth keeping past the merge, it becomes a `docs/research/` note or a paragraph in
  the branch it reviewed. It does not become a file per review.

## Scratch (`.work/`)

`.work/` is the only gitignored working space in the repo, and the only place where deletion is
always safe. Three rules keep it from becoming a second source of truth — which is what killed
`brain/`:

1. **Nothing durable lives there.** A finding that matters is promoted: `docs/research/` (dated,
   immutable), an RFC, an ADR, or the branch spec it settles.
2. **No spec, ADR or RFC may cite `.work/`.** If a record needs the evidence, the evidence gets
   promoted first. A citation to a file that can be deleted on any machine is a dangling reference
   waiting to happen.
3. **Do not write an explanation of this convention into `.work/`.** A gitignored README explains
   rules to nobody who clones the repo; the rules live here, in a tracked file.

`.work/` is not created in advance. Whoever needs it makes it; nothing in the repo depends on it
existing.

A record that names a product, a package or a chain belongs in the branches or the prototype doc.
An invariant that survives replacing every named technology belongs in the twin.

## Domain folders

The tree is one folder per domain, named as the paper names it: `author`, `publication`,
`agreement`, `gates`, `press`, `monetization`, `reader`. `system/` holds what spans them
(`SPEC-system-contract.md`, `SPEC-shared.md`).

A domain gets branches when its detail is spread across packages or hosts:

```
docs/specs/<domain>/SPEC-<domain>.md            the twin — invariants + record/branch index
docs/specs/<domain>/SPEC-<domain>-overview.md   the model across the parts: host matrix, reading order, drift
docs/specs/<domain>/SPEC-<domain>-<part>.md     one file per package or host, authoritative for its own area
```

The twin and the overview carry what spans the parts and never re-state a part's detail. Each
part names its parent in its header blockquote. Where twin and part disagree, the part wins for
its own area; where the twin and the paper disagree, the twin wins for the protocol.

Renaming or moving a spec means updating every live reference (the twin's index, `AGENTS.md`,
`docs/code-map/MAP.md`, RFC headers). Dated material under `docs/research/` and `docs/audits/`
keeps the old filenames on purpose — it describes the repo as it was at that date.

## Retired: `brain/`

Until 2026-11-04 there was a parallel `brain/` tree (gitignored, machine-local) holding
`specs/`, `research/`, `audits/`, `handoffs/`, `reviews/`, the agent registry and the code map.
It drifted from the docs and became the second source of truth, so it was retired: specs,
research, audits and the code map moved here, the agent registry became `AGENTS.md` at the repo
root, and `handoffs/`, `reviews/` and the worktree index were dropped as transient. Do not
reintroduce a second tree; if material has no home here, the taxonomies above are missing a row.

## Precedent

Ripples-from-revoke: the change contract lives in `docs/rfc/RFC-007-prep-ripples-from-revoke.md`;
`docs/specs/press/SPEC-protocol-actions.md` §"Ripples vs collections" carries only the
target-behaviour description, with a pointer to the RFC. The settled outcome is folded into the
branch after build + review. Older examples: `RFC-001` (portable byline) against
`docs/specs/author/SPEC-author.md` AUTHOR-9.
