# s2s Code Map

> Structural overview of the s2s monorepo, paired to brain specs. Keep this in
> context every session alongside the specs; it's the "where everything lives"
> index for reasoning about code without perusing every path.
>
> Regenerate the tree below with `~/s2s-repomix.sh map` when structure changes.

## Component index

| Component | Package | Spec(s) | Code LOC | Entry | What it is |
|---|---|---|---|---|---|
| `0xobsidian` | `@s2s/0xobsidian` | author/SPEC-author-identity, RFC-identity-key-custody | 6,657 | `src/main.ts` | Obsidian plugin — author identity, key custody, eth/filecoin/ipfs services |
| `neutralpress` | `@s2s/neutralpress` | author/SPEC-author-publishing, RFC-media-items | 4,987 | `src/main.ts` | Obsidian plugin — publishing: content → publication service → on-chain tx |
| `author-cli` | `@s2s/author-cli` | author/SPEC-author-cli | 3,255 | `src/cli.ts` | `s2s` headless binary — `author`/`publication`/`config` groups, `--json` machine contract, node adapters (viem, Pimlico Safe, kubo, Lit, Filecoin) |
| `nvim-s2s` | — (pure Lua, not in pnpm workspace) | author/SPEC-author-nvim | ~3.2k (branch `agent/nvim-core`, unmerged; absent from `main`) | `lua/s2s/init.lua` | Neovim wrapper over the `s2s` binary — spawns it, formats the one JSON result, no domain logic |
| `protocol` | `@s2s/protocol` | SPEC-protocol-actions, SPEC-contracts-ens, publication/SPEC-publication-account | 9,569 | (contracts `hardhat.config.ts`) | On-chain: Solidity contracts + Lit actions + CCIP gateway + serverless + deploy scripts |
| `safe-app` | `s2s-records-safe-app` | publication/SPEC-publication-admin-app | 5,641 | `src/main.ts` | Safe management UI (Vite) — records/deals/storage/whitelist tabs, state stores |
| `shared` | `@s2s/soul2soul-shared` | SPEC-shared, author/SPEC-author-shared | 7,374 | `src/index.ts` | Cross-cutting lib — identity/signing, lit actions+gates, publication, rendering, protocol, ipfs, the host-agnostic `authoring/` module |
| `website-starter` | `website` | publication/SPEC-publication-look | 2,851 | `templates/` | Neutral renderer/site template — handlebars templates, scss, upload scripts |
| `cid-mirror` | — (standalone, not in pnpm workspace) | RFC-cid-mirror | ~1.2k | `src/index.ts` | Dockerized ENS/IPFS → location-addressed static mirror — resolves `PUBLICATION_URL` to root CID via s2s L2 records-contract `contenthash_wrapped` (Base 8453 `getText`, `RECORDS_CONTRACT` override), traverses the kubo tree, downloads every leaf to `webcontent/` (host-shared for nginx), `POST /api/refresh` |

Total ~38k LOC. Specs are authoritative for *what/why*; this map is the *where*.

## Per-component key dirs

- **0xobsidian** — `src/eth/` (Safe + chains + viem/waap), `src/filecoin/`, `src/ipfs/` (pinata/kubo), `src/keystore/`, `src/user/` (author modal, ens), `src/main.ctrlr.ts`.
- **neutralpress** — `src/content/` (note/vault base), `src/publication/` (service, config, ens, github, tx-runner adapter), `src/factories/`, `src/ui/` (modals), `src/protocol.abi.ts`.
- **protocol** — `contracts/contracts/*.sol` (ENS registry, resolver w/ CCIP, publication modules V1/V2, records module), `actions/src/` (`prep/`, `render/`, `renderer/`, `update/` + libs: evm, gates, decrypt, ipfs, module/protocol factories), `ccip_gateway/`, `serverless/`, `scripts/` (`lit/`, `filecoin/`, `ens/`). Note: `generated/` + `contracts/generated/` are typechain output — excluded from dumps.
- **safe-app** — `src/components/` (s2s-app + tab components), `src/state/` (deal/protocol/record/safe/storage/ui/web stores), `src/lib/` (evm, protocol-integration, safe-integration, ipfs factories), `src/filecoin/car-builder.ts`.
- **shared** — `src/identity/` (jcs, sign/verify, contract-id), `src/lit/` (`actions/` encrypt+helpers, `gates/` can_publish/can_read, lit.service), `src/publication/` (assets/config builders, validation, tx-runner), `src/rendering/` (action-io, sequence, fixtures), `src/protocol/` (constants, schemas, types), `src/contracts/`, `src/ipfs/`, `src/content/`, `src/metadata/`.
- **website-starter** — `templates/` (home/page/post + partials), `scss/` (basics + styleguide), `scripts/` (upload, abi, ipfs, pinata, local-config-builder), `node-css-inject/`.
- **cid-mirror** — `src/` (`api/`, `ipfs/` incl. vendored `contenthash.ts`, `ens.ts`, `mirror.ts`, `config.ts`), `tests/`, `Dockerfile`, `docker-compose.yml` (bind-mount `./webcontent` for nginx). Standalone npm package; reuses vendored `shared/src/ipfs/contenthash.ts` + kubo RPC patterns.

## Repomix usage (economical tiers)

Wrapper: `~/s2s-repomix.sh`. Dumps → `/tmp` (ephemeral). Comments always kept.

- **Tier-0 `map`** — structure only, whole repo (~12KB). Always-on. → this file's tree.
- **Tier-1 `sig <comp>`** — compressed signatures + comments, one component (~100–350KB; ~1/25th the firehose). Prefer for reasoning about interfaces against specs. Note: for `protocol`, a narrowed Tier-2 (`full protocol "contracts/contracts/**/*.sol"` ≈ 81KB) can be smaller than a full sig.
- **Tier-2 `full <comp> [glob]`** — full bodies, one component, optionally narrowed with `--include`. Last resort; for bug-tracing/body-reading. One component at a time.

**Metering rules:** specs + this map = default context; load a code dump only when a question demands it; prefer Tier-1, escalate to Tier-2 only for bodies/bug-tracing; one component per dump; narrow with include before going full; drop a dump once the question is answered.

## Structure (snapshot)

```
0xobsidian/
  out/  src/{eth,filecoin,ipfs,keystore,paymaster,types,user,utils}/  src/main.ts  src/main.ctrlr.ts  test/
neutralpress/
  src/{content,contracts,factories,publication,ui}/  src/main.ts  src/main.ctrlr.ts  src/preview.ctrlr.ts  src/protocol.abi.ts  tasks/
protocol/
  actions/src/{libs,prep,render,renderer,update}/  action_globals.ts
  ccip_gateway/  serverless/
  contracts/contracts/{interfaces,*.sol}  contracts/scripts/  contracts/hardhat.config.ts
  generated/abis/  scripts/{ens,filecoin,lit}/  hardhat.config.ts
safe-app/
  public/  src/{components,filecoin,lib,state,styles,types,utils}/  src/main.ts  index.html  vite.config.ts
shared/
  src/{content,contracts,ens,filecoin,helpers,identity,ipfs,lit/{actions,gates},metadata,pin,protocol,publication,rendering}/  src/index.ts  src/lit-actions.ts  src/safe-app.ts
website-starter/
  ai-rules/  assets/  css/  node-css-inject/  scripts/  scss/{basics,styleguide}/  templates/{partials,*.handlebars}
cid-mirror/
  src/{api,ipfs}/  src/{config,ens,mirror,index}.ts  tests/  Dockerfile  docker-compose.yml  .env.example
docs/
  whitepaper/  prototype/            the two published sites
  specs/{system,author,publication,agreement,gates,press,monetization,reader}/
  adr/  rfc/  research/  audits/  code-map/  conventions.md
(repo root: AGENTS.md, README.md, docs/, src/, pnpm-workspace.yaml, eslint.config.js, vitest.config.base.ts)
(2026-11-04: the packages above moved under `src/`, and `brain/` was retired into `docs/` — this
snapshot's package paths are historical; `src/<domain>/<package>/` is the live layout.)
```

Full file-level tree: run `~/s2s-repomix.sh map` → `/tmp/s2s-structure.md`.
