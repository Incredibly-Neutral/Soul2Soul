# Monorepo Index
> Updated: 2026-06-19
> The `specs/` folder is the authoritative reference.

## Entry point — always start here

Read **`specs/SPEC-00-system-contract.md`** first. It covers:
- The four trust domains and topology
- The publish pipeline (PREP → SINGLE → MERGED)
- The Invariant Register — cross-cutting rules an isolated edit can silently break
- The Gap Register — unsettled / WIP areas and known contradictions
- Open tasks

## Package specs (read after SPEC-00)

| Spec file | Covers |
|---|---|
| `specs/SPEC-shared.md` | Canonical type catalog, entry points, validation module, gotchas |
| `specs/SPEC-protocol-actions.md` | Lit Action pipeline (prep / single / merged), renderer, libs |
| `specs/SPEC-contracts-publication.md` | Per-publication Safe modules (licensing/whitelist/config) |
| `specs/SPEC-contracts-ens.md` | Protocol-wide naming/resolution/site-root (L1+L2) |
| `specs/SPEC-0xobsidian.md` | Author identity / Safe / Lens (Obsidian plugin) |
| `specs/SPEC-neutralpress.md` | Publication lifecycle + authoring (Obsidian plugin) |
| `specs/SPEC-safe-app.md` | Publisher control panel (Safe app) |
| `specs/SPEC-website-starter.md` | Output templates / rendered site |

## Rules

- **Read SPEC-00 first**, then the component spec(s) for the part you are editing
- **If your change touches an invariant** listed in SPEC-00 §4, read the adjacent component spec too — your edit is not isolated
- **Types live in `shared/src/protocol/types.ts`** (the single source of truth). Do not define types elsewhere
- **The zod schemas in `shared/src/protocol/schemas.ts`** mirror the types for client-side validation. The `/lit-actions` entry point must never import zod (INV-7)
- This is a `pnpm` monorepo — always use `pnpm`, never `npm`