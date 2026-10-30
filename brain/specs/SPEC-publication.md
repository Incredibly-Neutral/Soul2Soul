# SPEC-publication — the publication (front door)

> **Type:** front/group spec. It carries the publication domain model, the cross-child invariants, and the
> index of the nested tree beneath it. It is **not** a component spec: the detail lives in the children,
> and where this file and a child disagree, the child wins for its own area.
>
> **Read first:** [SPEC-00](SPEC-00-system-contract.md) (system contract + invariants).
>
> **Children:** [`publication/SPEC-publication-account.md`](publication/SPEC-publication-account.md),
> [`publication/SPEC-publication-agreements.md`](publication/SPEC-publication-agreements.md),
> [`publication/SPEC-publication-review.md`](publication/SPEC-publication-review.md),
> [`publication/SPEC-publication-admin-app.md`](publication/SPEC-publication-admin-app.md),
> [`publication/SPEC-publication-look.md`](publication/SPEC-publication-look.md),
> [`publication/SPEC-publication-storage.md`](publication/SPEC-publication-storage.md).
>
> **Dependencies (siblings, not children):** [SPEC-shared](SPEC-shared.md) (types, orchestration,
> `cid-view`), [SPEC-protocol-actions](SPEC-protocol-actions.md) (the press: gates, decrypt, render,
> tree write), [SPEC-contracts-ens](SPEC-contracts-ens.md) (naming, `contenthash_wrapped`, the root
> write), [SPEC-author](SPEC-author.md) (the other side of every offer).
>
> **Restructured:** 2026-10-30 — `SPEC-contracts-publication`, `SPEC-safe-app`, `SPEC-website-starter`
> and `SPEC-contracts.md` were folded into this tree. See [Old → new paths](#old--new-paths).
>
> **Audited against live code:** 2026-10-30 (source reading at `85e9671`; `website-starter` at
> `dde6b0f`). No chain state was read — see [Not verified](#not-verified).

---

## The model in one paragraph

A publication is **an account that can say yes**. It is a Safe, deterministically derived from its name
and living at one address on two chains, carrying two modules on Base: one that holds agreements, and one
that holds a handful of string records. A work arrives as a **signed object** (an author's `genesis` plus
a CID); the publication either already agreed to it (**deal**) or has not decided (**offer**), and only
the Safe can move a work from one to the other. What the publication *is*, visually, is a repo of templates
compiled to a CID and referenced by a record; what it *publishes* is a tree of rendered HTML under a root
CID, whose only authoritative pointer is an ENS `contenthash_wrapped` record that the publication cannot
write itself. Everything a holder does is a Safe transaction; everything a reader sees is a CID.

## Anatomy

| piece | what it is | child |
|---|---|---|
| account | Safe + `S2SPublicationModuleV2` (proxy) + `S2SRecordsModule` (immutable) | [account](publication/SPEC-publication-account.md) |
| agreements | offer/deal sets, version log, whitelists | [agreements](publication/SPEC-publication-agreements.md) |
| read gate | who may decrypt a pending offer | [review](publication/SPEC-publication-review.md) |
| surface | `safe-app` — the five tabs, proposals, config build | [admin-app](publication/SPEC-publication-admin-app.md) |
| look | `mapping.json`, templates, assets, config CID | [look](publication/SPEC-publication-look.md) |
| site | MFS tree, copies, root, availability, mirror | [storage](publication/SPEC-publication-storage.md) |

## Lifecycle

1. **Created** — by CLI (`newPublicationSafe`, salt `'publication_safe_' + name`, L1 subname, two modules,
   owners added, deployer removed → **N-of-N**) or by the app for an existing Safe (two batches, addresses
   read back from `ModuleCreated` logs, then a 10-minute wait for a human to enable). See
   [account](publication/SPEC-publication-account.md).
2. **Configured** — `name`, `repo`, `branch`, optional `feed`, and `config` written as records; `config` is
   a CID built from a GitHub repo. See [look](publication/SPEC-publication-look.md).
3. **Fed** — authors append versions (`makeOffer`); entitled callers become deals, everyone else becomes an
   offer. See [agreements](publication/SPEC-publication-agreements.md).
4. **Decided** — `acceptOffer`, or `retract` (which the Safe uses to demote a deal or reject an offer).
5. **Rendered** — the press decrypts, renders, signs a colophon, assembles the tree, writes the root as the
   PKP. See [storage](publication/SPEC-publication-storage.md).
6. **Observed** — the tree tab and the storage tab read the root and probe retrievability.
7. **Torn down** — modules disabled, name record deleted; the site stays standing.

## Permissions

The whole surface, in one table. `onlySafe` is `msg.sender == safe`.

| target | `onlySafe` | also allowed |
|---|---|---|
| records: `setRecord`, `setRecords`, `deleteRecord` | ✓ | — |
| `acceptOffer` | ✓ | — |
| `retract` | ✓ (demote deal → offer, or reject an offer) | the **genesis author** (full withdrawal) |
| `makeOffer` | ✓ (lands as a deal) | `canPublish` addresses for a genesis's first version; `genesisAuthor` for later versions — a **developer's** work lands as an offer |
| whitelist add/remove | ✓ | — |
| `upgradeToAndCall` | ✓ | — |
| factory `createModule` / `setImplementation` | **nobody** | anyone — see [the upgrade edge](publication/SPEC-publication-account.md#upgradeability) |
| ENS `contenthash_wrapped` | **not the publication** | the PKP (INV-12), granted by the protocol |

## Invariants across the tree

- **INV-3** — module storage is append-only; the `Entry` struct is a return type, never storage.
- **INV-4** — modules are discovered by `NAME()`; the strings are interface.
- **INV-10** — every mutation is `onlySafe` or enumerated above; the app proposes, never sends.
- **INV-11** — templates and pages use root-absolute paths; serving is origin-per-CID.
- **INV-12** — the site root is written by the PKP, not by the publication.
- **INV-6** — `contenthash_wrapped`, EIP-1577, is the only authoritative pointer to a site.
- **One decision, one genesis.** `genesisAuthor` is written once and never changes; a work's identity and
  its owner are the same fact.
- **A deal is a bool.** Membership is the state; the version log is the history; nothing is deleted.

## Where the code wins over the folded specs

Recorded because the folded text was read by people who may still quote it.

| folded claim | code |
|---|---|
| `safe-app` workflow uses `grantLicense` / `acceptLicense` / `revokeLicense` | `makeOffer` / `acceptOffer` / `retract` — V2 renamed all three; the semantics are not identical (see [agreements](publication/SPEC-publication-agreements.md#corrections-to-the-folded-spec)) |
| "the offer path is only reachable through the publication Safe" | false: a whitelisted **developer** passes `canPublish` and their genesis becomes an offer |
| `retract` "author withdraws fully, safe demotes" listed under one row of `onlySafe` | the function has no modifier; the branch is on `msg.sender` |
| `NAME() == "S2S Publication Module V2"`, V1 "accepted for backwards-compatible discovery" | true in `shared`, false in `safe-app`, which matches only V2 |
| `ConfigBuilder` "fetch `mapping.json` verbatim" as *the* description | still verbatim, but the build also pins the commit, `dagPut`s a template DAG with real IPLD links, and mirrors to two providers |
| `website-starter` "legacy local render loop" | replaced: the dev loop drives the real render action through `S2S_RUNNER_URL`, with `contract-pull` as a mode |
| `templateConfig` "filters" implied to work | `templateConfig[].filters` is read by nothing |

## Deliberately not here

Ideas that exist as RFCs and are **not** part of this tree: media items as first-class content
(`RFC-media-items-1`), a protocol-wide deals ledger with `getBylines` (`RFC-protocol-wide-deals-ledger`),
a reviewer role and pre-decision read gate (nothing written yet — the gap is described in
[review](publication/SPEC-publication-review.md)), and gateway warm-up (`RFC-gateway-keepalive-warmup`).

## Old → new paths

| was | now |
|---|---|
| `brain/specs/SPEC-contracts-publication.md` | `brain/specs/publication/SPEC-publication-account.md` + `…-agreements.md` |
| `brain/specs/SPEC-safe-app.md` | `brain/specs/publication/SPEC-publication-admin-app.md` (+ `…-storage.md` for the tree/availability half) |
| `brain/specs/SPEC-website-starter.md` | `brain/specs/publication/SPEC-publication-look.md` |
| `brain/specs/SPEC-contracts.md` (the split router) | this file, §Anatomy |

Live references (`SPEC-00`, `SPEC-shared`, `SPEC-author`, `SPEC-protocol-actions`, `SPEC-contracts-ens`,
`SPEC-summary`, `brain/agents.md`, `brain/code-map/MAP.md`, RFC headers) were updated with the move.
Time-stamped records under `brain/prototype/`, `brain/handoffs/` and `brain/research/` are **not**
rewritten — they keep the old filenames on purpose, since they describe the repo as it was at that date.

## Not verified

- That deployed bytecode matches this source; that any live publication's enabled modules, threshold, or
  aliases are what the code implies.
- That `authorizeCaller(pkp, true)` was executed on the deployed records contract, and with which PKP.
- That `VITE_KUBO_TOKEN` is provisioned in the shipped bundle, and at what scope.
- That a Filecoin storage session exists in the operator's install — the legs are wired and skip cleanly, so
  "five copies" is a capability, not a measurement.
- Why the admin render path mirrors nothing: it reads as an omission, not a decision.
