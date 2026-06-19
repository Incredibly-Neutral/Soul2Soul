# SPEC-website-starter

> Component spec for `website-starter/` — the **downloadable templating starter** an author/templater
> clones to build a publication's look, plus a **legacy local render loop** slated for replacement by
> the Bun flow. Read **SPEC-00** first. It is the producer side of the config that
> **SPEC-safe-app**'s `ConfigBuilder` consumes; its templates are rendered by
> **SPEC-protocol-actions**. Follows SPEC-00 §7.
>
> Invariants touched: INV-11 (templates use root-absolute paths → origin-per-CID serving), and the
> single-renderer parity model (SPEC-00 §3.1).

## Responsibility

Owns the **author-facing template kit**: Handlebars templates + partials, SCSS/CSS, assets, and the
`mapping.json` that wires templates ↔ collections ↔ ripples. Also currently carries a **local dev/
render loop** (`dev-assistant`, `renderer`, `scripts`) — **transitional**, to be replaced by the Bun
runner (one renderer, run on Lit/Bun, SPEC-00 §3.1). Does not own publishing, contracts, or signing.

## Two parts

**A. Template kit (the durable deliverable):**
| path | role |
|---|---|
| `templates/*.handlebars` | `home`, `page`, `post` + `partials/` (`head`, `header`, `background`, `logo`, …) |
| `mapping.json` | `templateConfig` (reference/file/path/collections) + `ripples`; **carries publication-specific `feedAddress`/`postId`** |
| `scss/` → `css/` | styles (`sass` build) |
| `assets/` | static assets (now bundled into `/assets` by safe-app `AssetsBuilder`, INV-11) |
| `ai-rules/` | agent coding rules for templaters (e.g. `LOGGING_RULES.md`) |
| `node-css-inject/` | CSS injection helper (Pinata) |

**B. Local tooling (transitional — being replaced by the Bun flow):**
| path | role | state |
|---|---|---|
| `renderer/` (`html.ctrlr`, `handlebars.factory`, `main.ts`) | Handlebars render engine; reaches into `protocol/actions/src/libs/ipfs.factory` | **second renderer copy** — retire in favor of the action renderer via Bun |
| `dev-assistant/` (`main.ctrlr`, `local-config-builder`, ipfs/ens/pinata/fs) | local render loop: `getProtocolInfo` → `renderwithLitActions(preview=true)` | **pre-Chipotle** (Datil + `CHRONICLE_YELLOWSTONE` + `mintCapacityToken` + session sigs) → replace with Bun |
| `scripts/` (`build`, `render`, `upload`, `protocol`, `ens`, `ipfs`, `pinata`, `local-config-builder`) | dev/deploy scripts | partly legacy |

## The template-authoring contract (what an author must honor)

Templates are Handlebars: use `{{> partial}}`, iterate page data via `{{#each collections.<slug>}}`
(slug from `mapping.json` collections), and reference assets/links with **root-absolute paths**
(`.{{this.path}}`, `/assets/...`) — which is why serving must be origin-per-CID (INV-11 / OPEN-TASK-1).
Custom helpers (`formatDate`, `authorFromAddress`, …) live in `handlebars.factory`. **Helper + template
semantics must match the renderer that actually runs** — once the Bun flow is the single renderer,
parity is automatic; until then the local `renderer/` copy can drift from `protocol/actions/renderer/`.

## Shared surface consumed (dev-assistant only; transitional)

Entry point: `@s2s/soul2soul-shared` — `getProtocolInfo`, `renderwithLitActions`, `getProviders`,
plus the **pre-Chipotle** `createSessionSignatures`/`mintCapacityToken` (Datil). These go away when
dev-assistant is replaced by the Bun runner (which needs none of the Datil session-sig machinery).

## Invariants this component preserves

- **INV-11:** templates emit root-absolute paths; the published tree is served origin-per-CID.
- **Single-renderer parity (SPEC-00 §3.1):** the eventual contract is that the author's local preview
  runs the *same* action renderer via Bun, so a template renders identically in dev and prod.

## Local gotchas / gaps

- **Empty README** (`# website`) — the *downloadable starter* has no onboarding docs. Highest-value
  fix for adoption: document the template/mapping/asset contract and the author-owned `mapping.json`
  values (below).
- **`mapping.json` carries another publication's `feedAddress`/`postId`** until edited — the onboarding
  sharp edge (SPEC-safe-app). Mitigated once `ConfigBuilder` injects `feedAddress` (that TODO).
- **Three config builders** — safe-app `ConfigBuilder`, neutralpress `uploadConfig`, dev-assistant
  `LocalConfigBuilder` — a single-source violation (SPEC-00 GAP-12). Consolidate into `shared`.
- **Two renderers** — `website-starter/renderer/` vs `protocol/actions/renderer/` — parity hazard;
  resolved by retiring this one for the Bun flow.
- **Shape mismatches (same drift class as elsewhere):** the local renderer reads `config.template_cid`
  but the config type/builder uses **`templateCid`**; dev-assistant reads `protocolInfo.assets_gateway`/
  `data_gateway` (snake) but `S2SProtocolInfo` is **camelCase**. Confirms these paths are stale.
- **Hardcoded secret:** dev-assistant embeds a **Pinata JWT** (with scoped-key secret) in source +
  uses a named author's `PRIVATE_KEY_UNAMORE` — same class as GAP-9. Remove on the Bun migration.

## Safe-to-change vs do-not-touch

- 🟢 templates, partials, SCSS/CSS, assets, README (please); retire `renderer/` + `dev-assistant`
  in favor of Bun.
- 🔴 the template→config contract (`mapping.json` structure; the partial/helper names and
  `collections.<slug>` shape the action renderer expects); root-absolute path convention (INV-11).

## Test seams

- Render a fixture `template + mapping.json + templateData` **through the Bun runner** (the
  replacement renderer) → assert HTML. This doubles as the **parity check** that local preview ==
  production output, which is the whole point of collapsing onto one renderer.
- Lint `mapping.json` against the shared zod `mappingSchema` (SPEC-shared) before build.
