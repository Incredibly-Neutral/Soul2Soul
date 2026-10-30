# Brain docs conventions — SPEC vs RFC vs handoff

> The routing rule that keeps `brain/` honest: **SPECs describe behavior; they do not collect the
> remains of actions.** Working material (acceptance contracts, open confirmations, "must adapt"
> notes, status flags) belongs in an **RFC** or a **handoff**. A SPEC only receives the *settled
> outcome* of a change — after it is implemented and independently reviewed.

## The taxonomy

| artifact | where | purpose | lifecycle |
|---|---|---|---|
| **SPEC** | `brain/specs/SPEC-*.md` — or, when a component has a basis + several hosts, a group tree under `brain/specs/<group>/` with a front `SPEC-<group>.md` | Description of settled / target system behavior: the I/O contract, invariants, and how each action behaves. | Describes the system; updated only with settled outcomes. |
| **RFC** | `brain/specs/RFC-*.md` | Durable change proposal for behavior that is **not yet built**. Carries the required behavior, the acceptance contract, and the open confirmations. | Created when a change is proposed; when built + reviewed, fold the settled parts into the relevant SPEC and strike here. |
| **handoff** | `brain/handoffs/handoff-*.md` | Per-task pick-up contract for an executing session (the builder). | Created per task; consumed by the executing session; superseded once the PR lands. |

## Routing rule

- **Contract / working material** — acceptance criteria, open confirmations, "must adapt" notes,
  status flags, implementation gotchas → **RFC** (durable) and/or **handoff** (per-task). Never
  the SPEC.
- **Description of behavior** — what the system does (or is required to do) → **SPEC**.
- **Settled outcome** — after implementation + independent review, fold the now-true behavior
  description into the SPEC and strike the RFC.

## Nested SPEC groups

A component whose behavior is spread across a **basis** (an original package) plus several **hosts**
that all drive the same core gets a group tree instead of one flat file:

```
brain/specs/SPEC-<group>.md            front door — domain model, cross-host invariants, index, status
brain/specs/<group>/SPEC-<group>-<part>.md   one file per part, cross-linked to the front
```

The rules: the **front** carries what spans the parts (the model, the invariant map, the host
matrix, the reading order, the old→new path map) and never re-states a part's detail; each **part**
stays authoritative for its own host and names its parent in its header blockquote. Where front and
part disagree, the part wins for its own host. Moving a spec into a tree means updating every live
reference (SPEC-00's tree, `brain/agents.md`, `brain/code-map/MAP.md`) — time-stamped records under
`brain/prototype/` and `brain/handoffs/` keep the old filenames, since they describe the repo as it
was at that date. The trees today are `SPEC-author.md` + `author/` and `SPEC-publication.md` +
`publication/`.

## Precedent

The existing RFCs already encode this in their headers ("an RFC, not a spec… When built, fold
settled parts into the relevant SPECs and strike here"). This doc makes it central and
load-bearing instead of implicit in RFC headers.

## Example (2026-08-18)

Ripples-from-revoke: the change contract lives in `RFC-prep-ripples-from-revoke.md` + its
handoff; `SPEC-protocol-actions.md` §"Ripples from a revoke" carries only the target-behavior
description, with a pointer to the RFC. The settled outcome gets folded into the SPEC after build
+ review.
