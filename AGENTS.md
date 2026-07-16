# Soul2Soul
> Privacy-first, decentralized publishing protocol on Base.

## What this project is
- **Nature**: `production` — breakage means publications can't be authored or read.
- **NKS realm**: `s2s` — every session starts with `nks_orient` here.
- **Focus holon**: `#1 📦 Soul2Soul` — the protocol monorepo boundary.
- **Agent karta**: `#3 👤 Агент s2s` — adhikarin, steward of the focus holon.
  Your inbox: `nks_orient(focus="3")` at session start (self-locate fallback: `nks_admin(action="my_kartas")`).
- **Owner karta**: `#2 👤 joera` (svatantra 主) — out-of-mandate questions go here as `posed_to` vimarshas.
- **Stack**: TypeScript monorepo — pnpm, Vitest, Hardhat, ethers/viem, Lit Protocol, Safe, Filecoin/IPFS, Lens.
- **Production statement**: Soul2Soul publishes decentralized magazines/authorship on Base via Safe modules + Lit Protocol. Authors own keys, control identity via 0xobsidian (Obsidian plugin), publish via neutralpress, manage via Safe app. Content stored on IPFS/Filecoin. Breakage = authors can't publish or manage publications.

## Persistence rules
State lives in the **repo** or in **NKS** — nowhere else. Local agent memory
(conversation summaries, `/tmp`,
machine-local files) is **forbidden for project state**.
- **Repo**: code, configs, conventions, code-level gotchas, branch state.
- **NKS**: methodology, design decisions, open questions (vimarshas), plans,
  hand-offs, lessons, hints — the thinking around it. Don't restate NKS content
  in the repo; link to the vimarsha or holon.
- **Fetch state; never reconstruct it from memory.** No source for a "we
  decided…"? Stop and read NKS or the repo before acting.
- **External design/spec files are drafts to intake**, not the record — the
  graph holds the decisions; any such file is a view of them.
- **Memory write-gate.** Before saving any memory, classify the fact. Project
  fact (system property, decision, constraint, gotcha) → repo/NKS; memory keeps
  at most a one-line pointer. Agent/user-scoped (working style, preferences,
  language) → memory. Dual-nature facts: split.

## Session lifecycle
NKS = the work (structure, open questions, what's next). Git = how it got there.
**Keep git refs out of NKS** — no SHAs, branch names, PR numbers.
- **Start of session:** orient in NKS — realm `s2s`, focus holon `#1 📦 Soul2Soul`.
  Orient by the ACTIVE BIANHUA map (`lens="bianhua"`) — open work lives as
  anga-vimarshas on transformations. Then open your agenda:
  `nks_orient(focus="3")` — incoming `posed_to` vimarshas are your inbox; pick
  up or explicitly defer each before starting repo work.
- **Every push → update NKS.** Four moves, all required:
  - **Match reality.** Record what positions the change in the target system:
    architecture, module APIs, supply/delivery, UX, integration.
  - **Advance the map.** Close (visarjana) the vimarshas this push resolved;
    keep open work attached via `anga` to the bianhua it drives. A thin
    `genre=hint` seed is left only for what the graph can't carry.
  - **Sweep the shipped contour.** Flip designed nodes (anagata→vartamana,
    kalpita→pratyakshita) across the whole contour — not only the nodes you
    touched — and close the design vimarshas the ship settled.
  - **Sweep the inbox.** Close (visarjana) the `posed_to` questions your work
    answered; park stale ones.
- **Hooks merge.** No project-level hook system for Hermes — rely on
  `AGENTS.md` discipline for the NKS workflow.

### After a green push: self-review
Quality gate green and iteration done → re-read your diff for: bugs, fragile
spots, weak error handling, DRY/SOLID violations, repeated patterns, missing
or useless tests, files over 150 lines or god-units (split by concern). Fix in
the **same branch** and push again, or state plainly that nothing surfaced.

### Branch discipline
One branch through to its merge — commit follow-ups into it, don't chain new
branches. After merge:
1. `git checkout main && git pull`.
2. Delete merged branch (`git branch -d <name>`); prune others on `main`.
3. Update NKS: change is on `main`, not a branch — thread shipped state into
   the holon, close vimarshas the merge resolved.
4. Confirm cleanup before the next task.

## Working principles
1. **Think before coding.** State assumptions; ask when uncertain. Check repo +
   NKS before writing; fetch, don't recall. Hit the live system before trusting
   a type, a name, or a doc. Out-of-boundary questions become vimarshas
   `posed_to` joera's `#2 👤 joera` karta — not silent decisions.
2. **Simplicity first.** Minimum code for the task. No speculative features, no
   abstractions for single-use code. Validate at boundaries; trust internal
   invariants. 200 lines that could be 50 → rewrite.
3. **Surgical changes.** Touch only what the task needs. Don't reformat or
   refactor adjacent code. Match existing style; the linter is authoritative.
4. **Goal-driven execution.** Tasks → verifiable goals. Bugs: pin with a
   failing test before patching. Multi-step: state plan as `step → verify`
   pairs. Runtimes: verify in the real environment (browser, real API,
   downstream system), not just unit tests.
5. **Methodology check on open-ended asks.** Tasks framed as *discuss / think
   through / figure out / research / design / plan / analyse / investigate /
   explore* — query the `methodology` realm before answering.

## NKS ↔ repo: where things live
| Concern | Repo | NKS |
|---|---|---|
| Code, configs, lockfiles | ✓ | |
| Commands, conventions, gotchas, stack | ✓ (AGENTS.md) | |
| Current branch state, how to verify | ✓ (HANDOVER.md) | |
| Gaps in external systems we depend on | ✓ (MISSING_*.md) | |
| Methodology, ontology | | ✓ (methodology realm) |
| Design decisions, open questions | | ✓ (vimarshas) |
| Plans, task lists, session hand-offs | | ✓ (s2s realm) |
| Lessons, hand-offs | | ✓ (graph first; thin `genre=hint` for off-map remainder) |
| Commit history, PRs, SHAs | git | (never NKS) |

## Stack
- **Runtime**: Node.js (TypeScript, compiled via tsc/esbuild/Vite)
- **Contracts**: Solidity + Hardhat + ethers/viem
- **L1**: Base (Safe L2 v1.4.1, 4337, Pimlico paymaster)
- **Identity**: Lit Protocol (PKPs, Lit Actions, did:ethr)
- **Storage**: IPFS (Helia, Kubo) + Filecoin (Synapse/filecoin-pin)
- **Lens**: Lens Protocol SDK + Storage Client
- **Monorepo**: pnpm workspace, 6 packages

## Commands
| Command | What |
|---|---|
| `pnpm test` | Run all workspace tests |
| `pnpm build` | Build all packages (tsc/esbuild/vite per-pkg) |
| `pnpm -r test` | Run tests in all packages |
| `pnpm lint` | ESLint with strict TypeScript rules |
| `pnpm format` | Prettier auto-format |
| `pnpm actions:build` | Build Lit Actions (protocol) |
| `pnpm deploy-action` | Build + swap + update Lit Actions |
| `pnpm run build` (per-pkg) | Package-specific build |

Lint runs zero-warning where `tsc --strict` is enabled. The root `tsconfig.json`
is for tooling only; each package has its own tsconfig.

## Project structure
| Directory | What |
|---|---|
| `shared/` | Canonical types, protocol helpers, filecoin/IPFS, Lit gates, ENS — the single shared lib |
| `protocol/` | Solidity contracts + Hardhat config + Lit Actions scripts + Filecoin scripts |
| `0xobsidian/` | Obsidian plugin — author identity, Safe management, Lens profile, keychain |
| `neutralpress/` | Obsidian plugin — publication lifecycle, authoring, content management |
| `safe-app/` | Vite-based Safe control panel — Records, History, Settings, Storage tabs |
| `website-starter/` | Static website starter template + upload scripts |
| `specs/` | System specs — SPEC-00 (system contract) + per-component specs |

## Code conventions
- **Types:** `shared/src/protocol/types.ts` is the single source of truth. Do not
  define types elsewhere. (why: schema drift across the monorepo broke things.)
- **Zod schema:** `shared/src/protocol/schemas.ts` mirrors types for client-side
  validation. The `/lit-actions` entry point must never import zod (INV-7).
- **Package-specific tsconfig** — each package has its own. Root tsconfig is only
  for deploy/generated/hardhat tooling.
- **EIP-712:** `buildSigningView` computes `tagsHash`/`attributesHash`; viem
  needs explicit `primaryType`.
- **Lit Actions:** author passes through as `DidEthr` (no `eoaOf` transform).
- **`toBytes32Id`:** passthrough `0x+64hex`, keccak256 otherwise. Used in
  makeOffer/acceptOffer/retract/hasDeal/canRead.
- **Test discipline**: Vitest for `shared/` + `0xobsidian/`; Hardhat node test
  runner for `protocol/` contracts. No coverage threshold set yet.
- **Linter**: ESLint + `@typescript-eslint/strictTypeChecked`. Auto-fix with
  `pnpm lint --fix`.
- **Formatter**: Prettier. Auto-format with `pnpm format`.
- **Gotchas**:
  - **Shared mutable state — on-chain contracts.** Contracts on Base are shared
    across parallel agent worktrees. No per-branch isolation currently.
    Hardhat compilation artifacts (`cache/`, `typechain-types/`) can also
    conflict across concurrent agents — avoid running parallel builds.
  - **`website-starter/scripts/local-config-builder.ts` is git-tracked** and
    contains Pinata/IPFS upload utilities that likely reference secrets. Never
    `git add -A` or `commit -a` — use `git update-index --skip-worktree` on
    this file to prevent accidental exposure.
  - **`safe-app/public/session-key.json`** — gitignored but never stage it.
    `git add -A` will not pick it up, but explicit `git add safe-app/` might.
  - **No CI currently** — lint + tests must be run manually before pushing.
    CI is planned but not wired.
  - **Two separate uploads** (config JSON + assets tree) — single-DAG
    consolidation deferred. CID parity between Kubo and Filecoin Root CID is
    required and verified.

## What to update when
- `AGENTS.md` — commands, structure, conventions, or stack change.
- `HANDOVER.md` — current branch state shifts (branch, what's runnable/blocked).
  Not a changelog.
- `MISSING_*.md` — a need surfaces that an upstream/downstream system doesn't
  satisfy yet.
- NKS (s2s realm) — every push (see Session lifecycle).

## Git workflow
- **Conventional commits** (`feat:`/`fix:`/`chore:`/`refactor:`/`docs:`/`test:`).
  Branches `feat/…`, `fix/…`, `chore/…`.
- **No co-author trailer** unless the user asks.
- **Definition of done**: PR into `main` via GitHub; merge when CI would be
  green (or, until CI is wired, after manual `pnpm test` + `pnpm build` + lint).
- **Never** `--no-verify`, `--force`, `--no-gpg-sign`, or `git reset --hard`
  without explicit instruction.