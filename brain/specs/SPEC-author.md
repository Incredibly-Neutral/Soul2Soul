# SPEC-author — authoring (front door)

> **Type:** front/group spec. It carries the authoring domain model, the cross-host invariants, and
> the index of the nested tree beneath it. It is **not** a component spec: the detail lives in the
> children, and where this file and a child disagree, the child wins for its own host.
>
> **Children:** [`author/SPEC-author-identity.md`](author/SPEC-author-identity.md),
> [`author/SPEC-author-publishing.md`](author/SPEC-author-publishing.md),
> [`author/SPEC-author-shared.md`](author/SPEC-author-shared.md),
> [`author/SPEC-author-hosts.md`](author/SPEC-author-hosts.md),
> [`author/SPEC-author-cli.md`](author/SPEC-author-cli.md),
> [`author/SPEC-author-nvim.md`](author/SPEC-author-nvim.md).
>
> **Dependencies (siblings, not children):** [SPEC-00](SPEC-00-system-contract.md) (read first),
> [SPEC-shared](SPEC-shared.md) (canonical types + orchestration),
> [SPEC-protocol-actions](SPEC-protocol-actions.md) (the other side of the render boundary),
> [SPEC-publication](SPEC-publication.md) /
> [SPEC-contracts-ens](SPEC-contracts-ens.md) (the chain side of the gate).
>
> **Restructured:** 2026-10-29 — the authoring basis (`SPEC-0xobsidian`, `SPEC-neutralpress`),
> the host split (`SPEC-hosts`) and the two new hosts (`SPEC-author-cli`, `SPEC-nvim-s2s`) were
> folded into one nested tree under this file. See [Old → new](#old--new-paths).

---

## The model in one paragraph

Authoring is the act of **producing one signed object and writing it to a publication's append
log**. The interface is the object (`S2SContentItem`), not an application: any program that can emit
one is a legitimate client. Identity is an **address that cannot move** — the author Safe, a
counterfactual ERC-4337 account owned by an EOA that only ever signs. The gate is a **function of
chain state read at the moment of acting** (`canPublish(msg.sender)`), never a server-side
permission. There is no authoring API, no account, no session; every host is a different runtime
driving the same pure orchestration out of `shared`, with its own thin adapters.

## The signed object (the contract everything else is built on)

- `S2SContentItem` is EIP-712 signed over the canonical (JCS) public metadata; `objectId` is the
  EIP-712 digest of that public part and **exists before publication** — it is derived from local
  bytes, and no CID is needed to compute it (`shared/src/identity/sign-content.ts`).
- `plaintextHash` (keccak over the canonical body) lives **inside** the signed public metadata,
  while the body itself does not — that is what lets an offer commit to a document nobody can read
  yet.
- `proof.signer` is the **EOA** (the key that signed); `author` is `did:ethr:<authorSafe>` (the
  identity that may publish). These are deliberately different fields — see the actor invariant
  below.
- Frontmatter is the note's memory of that object: `genesis` (stable bytes32 identity), `author`
  (the Safe), `kubo_cid` (the CID of the last upload — ephemeral, overwritten by the next upload),
  `slug` (moves the rendered path), and the legacy `content_id` (the Lens-era name for `genesis`,
  still read as a fallback).

## Identity: a counterfactual Safe, not an EOA

| | author Safe | publication Safe |
|---|---|---|
| salt | `"s2s_" + eoa` | `"publication_safe_" + name` |
| saltNonce | `keccak256(salt)` (unmasked, chain-free) | `keccak256(salt)` |
| implementation | SafeL2 v1.4.1, owners `[eoa]`, threshold 1 | same |
| EntryPoint | v0.7 (selects the 4337 module, so it is part of the address) | same |
| consequence | one address on L1 and L2 | L1 = ENS subnode owner, L2 = module host |

The salt excludes the chain on purpose: the same author (and the same publication) has one address
on both chains, which is what makes the L1-owner / L2-modules topology in
[SPEC-contracts-ens](SPEC-contracts-ens.md) work. Changing either salt changes every downstream
address — do not touch them casually.

## The actor invariant (INV-10, the one that bites)

The on-chain author identity is the **author Safe**, because that is what a publication whitelists.
`makeOffer`/`retract` sent from the EOA revert `OnlySafe()`, and a genesis whose first version was
written by the EOA is permanently stamped `genesisAuthor = EOA`, locking the Safe and every plugin
out of that document. So: **the Safe acts, the EOA signs**. That rule is uniform across the
obsidian plugin, the binary, and the safe-app; only the transport differs (private key + oxo runner,
private key + Pimlico userOp, SafeAppsSDK proposal). Full statement:
[SPEC-00](SPEC-00-system-contract.md) INV-10.

## Host matrix

| host | package | runtime | ETH actor | tx model | owns |
|---|---|---|---|---|---|
| obsidian identity | `0xobsidian` (`oxo-core`) | plugin, esbuild | author Safe (4337 via permissionless) | execute with private key | keypair, per-chain Safe, key custody |
| obsidian publishing | `neutralpress` | plugin, esbuild | author Safe (via oxo) | execute with private key | publication lifecycle, note → signed item, render trigger |
| browser | `safe-app` | iframe, Vite | **the Safe itself** | SafeAppsSDK propose-to-queue | "make this existing Safe a publication" + author flows from the Safe |
| binary | `author-cli` (`s2s`) | node | author Safe (Pimlico userOp) | execute with private key | headless authoring + full fresh creation (twin Safes + L1 ENS) |
| editor | `nvim-s2s` | Neovim Lua | none — delegates | spawns the binary | UI only |

`safe-app` is a host **and** a publisher control panel (records, deals, storage, tree), which is why
it keeps its own spec ([publication/SPEC-publication-admin-app](publication/SPEC-publication-admin-app.md)) outside this tree. `nvim-s2s` is a client,
not an independent transaction host: it has no adapters and holds no domain state.

## Reading order

1. [SPEC-00](SPEC-00-system-contract.md) — the system contract and the invariant list.
2. This file — the domain model and the invariants that span hosts.
3. [author/SPEC-author-hosts.md](author/SPEC-author-hosts.md) — how the work is divided, and why.
4. The host you are changing, plus [author/SPEC-author-shared.md](author/SPEC-author-shared.md) for
   the seam it imports through.
5. [SPEC-shared](SPEC-shared.md) for canonical types; [SPEC-protocol-actions](SPEC-protocol-actions.md)
   or [SPEC-publication](SPEC-publication.md) when the change crosses the
   render or chain boundary.

## Status of the tree

| child | describes | last audited against code |
|---|---|---|
| `SPEC-author-identity.md` | `0xobsidian` | 2026-08-03 |
| `SPEC-author-publishing.md` | `neutralpress` | 2026-08-03 (partial 08-06) |
| `SPEC-author-shared.md` | the authoring seam in `shared` | 2026-10-29 (new) |
| `SPEC-author-hosts.md` | the host split (AD-1…AD-5) | 2026-10-17 |
| `SPEC-author-cli.md` | `author-cli` | 2026-10-26 (actor section uncommitted) |
| `SPEC-author-nvim.md` | `nvim-s2s` | 2026-10-22 — still marked DESIGN |

## Known drift (2026-10-29)

Recorded here so the tree is not read as uniformly current. Each item belongs in a
[RFC](RFC-0xobsidian-identity-key-custody-1.md) or a handoff once it is being worked, not here.

- **`SPEC-author-nvim` is a design doc for shipped code.** The plugin exists on `agent/nvim-core`
  and `agent/nvim-format` (12+ commits, 2026-10-26), unmerged, so `nvim-s2s/` is absent from `main`.
  The implementation also diverged: one `:S2S <action>` command instead of `:S2sUpload`-style
  per-action commands, and it *locates* the result object in stdout instead of requiring a clean
  document.
- **The stdout contract is contradicted in practice.** `SPEC-author-cli` promises "stdout carries
  exactly one document"; the plugin scans for JSON because the binary's fire-and-forget durability
  legs can leak human progress onto stdout. One of the two sides should change — see
  `SPEC-author-nvim` §Invocation.
- **`SPEC-author-cli`'s status header is behind the code**: still "scaffold + pure-part tests" while
  the Safe-identity, bundler and gas-price work has landed, and two output-shaping gotchas live only
  as code comments (basename-not-path for `parseMarkdownNote`; join-not-concat for render URLs).
- **`SPEC-author-identity` / `SPEC-author-publishing` predate the content-item model.** They still
  name `S2SBody`, the Lens account/feed and `lens.createFeed`, all of which `SPEC-shared` marks
  deprecated or dead. Their flows are still accurate for the plugin; their types are not.
- **The front matter of the basis specs is stale in place.** `SPEC-author-hosts` still describes
  the binary as a future ticket and lists three hosts; there are four runtime surfaces now.

## Background (not specs)

Point-in-time material that explains *why* the tree looks like this, and that is **not** authoritative:

- `brain/prototype/02-authoring.md` — the authoring chapter of the prototype reading.
- `brain/prototype/02-authoring-implementation.md` — the implementation decisions behind it (D1…D12).
- `brain/audits/polyphony-authoring-compliance-2026-10-25.md` — the prototype read against Polyphony
  §2, with the scorecard and the trade of each choice.
- `brain/whitepaper/01-content-authoring.md` — the protocol-level intent.

## Old → new paths

| was | now |
|---|---|
| `brain/specs/SPEC-0xobsidian.md` | `brain/specs/author/SPEC-author-identity.md` |
| `brain/specs/SPEC-neutralpress.md` | `brain/specs/author/SPEC-author-publishing.md` |
| `brain/specs/SPEC-hosts.md` | `brain/specs/author/SPEC-author-hosts.md` |
| `brain/specs/SPEC-author-cli.md` | `brain/specs/author/SPEC-author-cli.md` |
| `brain/specs/SPEC-nvim-s2s.md` | `brain/specs/author/SPEC-author-nvim.md` |
| — (new) | `brain/specs/author/SPEC-author-shared.md` |

Live references (`SPEC-00`, `SPEC-shared`, `brain/agents.md`, `brain/code-map/MAP.md`, the RFC
headers) were updated with the move. Time-stamped records under `brain/prototype/` and
`brain/handoffs/` are **not** rewritten — they keep the old filenames on purpose, since they
describe the repo as it was at that date.
