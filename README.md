# s2s — Soul2Soul

Soul2Soul is a prototype of **Polyphony**, a protocol for independent authors and collective publications. It is early alpha, built by Incredibly Neutral; work on it began in early 2025.

Publishing has always had three parties: the author, the publication, and the press that turns a manuscript into something readers can see. The parties were never equal. The publication held the relationship with the press, and much of its power over the author came from that. Polyphony moves the press into a neutral position between the two.

Its press is open code running on sealed hardware that not even its owners can see into. It decrypts a manuscript, renders the page and signs it with its own key. It does this only while an agreement covers that manuscript, so neither the author nor the publication can produce a valid page alone. The rest follows from that:

- Anyone can start a publication with little effort, alone or with others.
- An author can end an agreement alone, at once, on a public ledger, and request a rebuild of the pages without the work.
- Every page carries proof of who wrote it, that both sides consented, and that it hasn't changed.
- Authors keep their work when they leave. A publication keeps its authors only while they choose to stay.

What remains is trust in that hardware, and in its owners not to collude. Beyond that, the design assumes the worst of whoever runs a publication and whoever hosts its pages, and is built to hold against both. It is not built to hold against a state-level adversary.

Read more:

- `polyphony.eth.link` — the white paper: what an implementation must guarantee.
- `about.soul2soul.eth.link` — this implementation: the choices made, the trade-offs accepted, where it falls short.

---

## What each piece is

**`shared`** — the cross-cutting library every other package builds on: identity and signing, Lit actions and gates, publication and rendering, protocol types, IPFS, and the host-agnostic `authoring/` seam that the authoring hosts share.

**`press`** — the neutral renderer. Nothing here sees a manuscript in the clear until an agreement covers it.

- `actions` — the Lit actions themselves: `prep` prepares a manuscript, `render` / `render-dev` decrypt and render the page, `renderer` and `update` sit behind them, `maintain-cache` and `repoint-archive` keep published output reachable.
- `serverless` — the Bun runner behind `run.transport-union.dev`: fetches an action's JS by CID, executes it, returns the signed result.
- `scripts` — deploy and ops for the above: Lit action add/swap/remove, group deploy and inspect, Filecoin and ENS setup, module checks.

**`publication`** — the on-chain side.

- `contracts` — `S2SPublicationModule(V2)`, one self-upgradable module per publication, plus the factory and `S2SRecordsModule`.
- `ens-contracts` — the names: an open subdomain registry, a resolver with CCIP-Read, and L2 records.
- `safe-app` — the admin UI a publication uses to run itself: records, agreements, storage, lists.

**`author`** — where manuscripts come from. Five hosts over one binary contract: the CLI holds the logic, the editors shell out to it and format its JSON.

- `author-cli` — the `s2s` binary, headless and machine-friendly: `init`, `address`, `config`, `new`, `upload`, `offer`, `preview`, `publish`, `revoke`.
- `0xobsidian` — Obsidian plugin for identity and key custody: the wallet, keystore, eth / Filecoin / IPFS clients, paymaster. It does not publish.
- `neutralpress` — Obsidian plugin for publishing, on top of 0xobsidian: content, publication state, render and preview UI.
- `vscode-s2s` — VS Code extension for a remote window: spawns the binary and parses its output.
- `nvim-s2s` — Neovim plugin, pure Lua, no build step (`src/author/nvim-s2s/`; no `package.json`, so pnpm leaves it alone): `:S2S upload|offer|preview|publish|revoke` on the current buffer, plus `new`, `config`, `health`.

**`reader`** — the read path.

- `gateway` — CCIP-Read gateway behind `ccip.transport-union.dev`: answers ENS resolver calls out of Base.

**`ipfs-check`** — batch availability proxy in front of `ipfs-check`: `POST /batch` in, NDJSON out.

**`docs`** — the two published sites, in Markdown with frontmatter.

**`brain`** — the working memory: specs (authoritative for what and why), handoffs, research, reviews, code map.
