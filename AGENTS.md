# Monorepo Index
> Generated: 2026-05-02T10:58:53.776Z

## Packages
Each package has its own ABI.md with full type/interface/function signatures.

- `@s2s/0xobsidian` → `0xobsidian/ABI.md`
- `@s2s/neutralpress` → `neutralpress/ABI.md`
- `@s2s/protocol` → `protocol/ABI.md`
- `@s2s/soul2soul-shared` → `shared/ABI.md`

## Rules
- Always check `shared/ABI.md` regardless of working directory — imported by all packages
- Do NOT read ABI.md files wholesale — reference specific sections as needed
- ABI.md contains signatures only, no implementation logic
- FLOWS.md per package describes runtime flows, crypto interactions, and service connections