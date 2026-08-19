# Brain docs conventions — SPEC vs RFC vs handoff

> The routing rule that keeps `brain/` honest: **SPECs describe behavior; they do not collect the
> remains of actions.** Working material (acceptance contracts, open confirmations, "must adapt"
> notes, status flags) belongs in an **RFC** or a **handoff**. A SPEC only receives the *settled
> outcome* of a change — after it is implemented and independently reviewed.

## The taxonomy

| artifact | where | purpose | lifecycle |
|---|---|---|---|
| **SPEC** | `brain/specs/SPEC-*.md` | Description of settled / target system behavior: the I/O contract, invariants, and how each action behaves. | Describes the system; updated only with settled outcomes. |
| **RFC** | `brain/specs/RFC-*.md` | Durable change proposal for behavior that is **not yet built**. Carries the required behavior, the acceptance contract, and the open confirmations. | Created when a change is proposed; when built + reviewed, fold the settled parts into the relevant SPEC and strike here. |
| **handoff** | `brain/handoffs/handoff-*.md` | Per-task pick-up contract for an executing session (the builder). | Created per task; consumed by the executing session; superseded once the PR lands. |

## Routing rule

- **Contract / working material** — acceptance criteria, open confirmations, "must adapt" notes,
  status flags, implementation gotchas → **RFC** (durable) and/or **handoff** (per-task). Never
  the SPEC.
- **Description of behavior** — what the system does (or is required to do) → **SPEC**.
- **Settled outcome** — after implementation + independent review, fold the now-true behavior
  description into the SPEC and strike the RFC.

## Precedent

The existing RFCs already encode this in their headers ("an RFC, not a spec… When built, fold
settled parts into the relevant SPECs and strike here"). This doc makes it central and
load-bearing instead of implicit in RFC headers.

## Example (2026-08-18)

Ripples-from-revoke: the change contract lives in `RFC-prep-ripples-from-revoke.md` + its
handoff; `SPEC-protocol-actions.md` §"Ripples from a revoke" carries only the target-behavior
description, with a pointer to the RFC. The settled outcome gets folded into the SPEC after build
+ review.
