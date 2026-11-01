# s2s — Soul2Soul

Soul2Soul is a prototype of **Polyphony**, a protocol for independent authors and collective publications. It is early alpha, built by Incredibly Neutral; work on it began in early 2025.

Publishing has always had three parties: the author, the publication, and the press that turns a manuscript into something readers can see. The parties were never equal. The publication held the relationship with the press, and much of its power over the author came from that. Polyphony moves the press into a neutral position between the two.

Its press is open code running on sealed hardware that not even its owners can see into. It decrypts a manuscript, renders the page and signs it with its own key. It does this only while an agreement covers that manuscript, so neither the author nor the publication can produce a valid page alone. The rest follows from that:

- Anyone can start a publication with little effort, alone or with others.
- An author can end an agreement alone, at once, on a public ledger, and request a rebuild of the pages without the work.
- Every page carries proof of who wrote it, that both sides consented, and that it hasn't changed.
- Authors keep their work when they leave. A publication keeps its authors only while they choose to stay.

What remains is trust in that hardware, and in its owners not to collude. The design defends against whoever runs a publication or hosts its pages, not against a state-level adversary.

Read more:

- `polyphony.eth.link` — the white paper: what an implementation must guarantee.
- `about.soul2soul.eth.link` — this implementation: the choices made, the trade-offs accepted, where it falls short.

---

## Domains

| Domain | What it serves | Code / content |
|---|---|---|
| `polyphony.eth.link` (`.eth.limo`) | The white paper | `docs/whitepaper/` |
| `about.soul2soul.eth.link` (`.eth.limo`) | Implementation notes: introduction, author, manuscript, publication, agreement, gates | `docs/prototype/` |
| `<publication>.soul2soul.eth.limo` / `.eth.link` | A live publication's site: ENS contenthash → resolver → CCIP gateway → Base | rendered output of `src/press/actions/render`, `src/publication/*` |
| `<cid>.preview.transport-union.dev` | Preview render of a root CID before publishing | `src/shared/src/authoring/links.ts` |
| `ipfs.transport-union.dev` | Operator Kubo node: gateway and pinning | `src/shared/src/ipfs/` |
| `ipfs-check.transport-union.dev` | Batch availability proxy in front of `ipfs-check` | `src/ipfs-check/` |
| `ccip.transport-union.dev` | CCIP-Read gateway: ENS resolver calls answered from Base | `src/reader/gateway/` |
| `run.transport-union.dev` | Lit-action runner: fetches action JS by CID and executes it | `src/press/serverless/` |
| Safe app (operator host, `rsync` to `/srv/publication-module/`) | Publication admin UI: records, agreements, storage, lists | `src/publication/safe-app/` |

`.eth.link` and `.eth.limo` are two domain fronts for the same operator (eth.limo). A browser hits the `.limo` form, `<pub>.soul2soul.eth.limo`; the `.link` form reaches the same backend.

---

## Monorepo layout

The pnpm workspace covers `src/author/*`, `src/publication/*`, `src/press` and `src/shared`. Everything else is standalone.

```
src/
  shared/              @s2s/soul2soul-shared
    authoring/  cid-view/  content/  contracts/  ens/  filecoin/  gates/
    heal/  helpers/  ipfs/  lit/  manuscript/  metadata/  pin/
    protocol/  publication/  rendering/
  press/               @s2s/press — the press itself
    actions/           Lit actions: prep/ render/ render-dev/ renderer/ update/
                       maintain-cache/ repoint-archive/, libs/
    serverless/        Bun Lit-action runner (Docker): server.ts → run.transport-union.dev
    scripts/           deploy + ops: lit/ filecoin/ ens/, check-module.ts
  publication/
    contracts/         @s2s/publication-contracts — S2SPublicationModule(V2),
                       Factory, S2SRecordsModule, interfaces/
    ens-contracts/     @s2s/ens-contracts — ENSOpenSubdomainRegistry,
                       ENSResolverWithCCIP, ENSL2nRecords
    safe-app/          s2s-records-safe-app — Vite admin UI: components/ state/
                       lib/ styles/ types/ utils/, e2e/ qa/ tests/
  author/              authoring hosts, all over the same binary contract
    0xobsidian/        @s2s/0xobsidian — Obsidian plugin, identity + key custody:
                       eth/ filecoin/ ipfs/ keystore/ paymaster/ user/ utils/
    neutralpress/      @s2s/neutralpress — Obsidian plugin, publishing:
                       content/ publication/ render/ ui/
    author-cli/        @s2s/author-cli — the `s2s` binary: cli.ts,
                       commands/ core/ adapters/ lib/
    vscode-s2s/        VS Code extension — spawns the binary:
                       extension.ts, commands.ts, spawn.ts, format.ts, parse.ts
  reader/
    gateway/           ccip-read-gateway — ENS read path into Base (Docker)
  ipfs-check/          batch proxy for ipfs-check: POST /batch → NDJSON
  scripts/             heal-observe.mjs, vendor/
docs/                  adr/ rfc/ protocol/ prototype/ whitepaper/ research/ glossary.md
brain/                 specs/ handoffs/ research/ reviews/ whitepaper/ code-map/ threat-model/
```

### What each piece is

- **`shared`** — the cross-cutting library: identity and signing, Lit actions and gates, publication and rendering, protocol types, IPFS, and the host-agnostic `authoring/` seam that every authoring host builds on.
- **`press`** — the neutral renderer: Lit actions bound to a PKP decrypt and render, `serverless` runs those actions, and `scripts` deploys and maintains them.
- **`publication`** — the on-chain side: a self-upgradable publication module per publication, the ENS registry/resolver pair, and the Safe app a publication uses to administer itself.
- **`author`** — where manuscripts come from: four hosts over one binary contract. The CLI holds the logic; the editors shell out to it and format its JSON.
- **`reader` / `ipfs-check`** — the read path and its availability checks: resolving a name to a CID, and checking that the content behind it can still be fetched.
- **`docs`** — the two published sites, in Markdown with frontmatter.
- **`brain`** — the working memory: specs (authoritative for what and why), handoffs, research, reviews, code map.

---

## Working in here

```bash
pnpm install
pnpm test          # pnpm -r test
pnpm lint
pnpm plugins       # shared → 0xobsidian → neutralpress
pnpm author-cli:build
```

Read `brain/agents.md` first, then the spec for the package you are touching. `brain/code-map/MAP.md` is the index of where everything lives, and `brain/specs/` holds the invariants and test seams for each component. Specs are authoritative for what and why; the code map says where.