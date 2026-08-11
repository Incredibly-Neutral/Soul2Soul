# RFC — Agent-optimized website-starter dev kit (local render + fixtures)

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the plan to make a
> publication's templates/helpers locally renderable and iterable — by a human *and* by an agent —
> with a local-only data source. Distinct from **RFC-content-transforms.md** (RFC A: the runtime
> *enclave mechanism* for content transforms + publication helper injection). **This RFC is RFC B:
> the developer tooling** that operates on a publication's site (e.g. `~/code/s2s-s3ntiment`, a
> `website-starter` fork).
>
> **Origin:** joera direction (2026-08-10).
>
> **Target repo:** `~/code/s2s-s3ntiment` — a `website-starter` fork (templates, `scripts/local-config-builder.ts`,
> `mapping.json`, `scss`) with **no local render today**. This is what the agent would work on.

---

## Why this RFC exists

A publication template/helper dev — and the agent doing that work — needs a fast local loop: see a
template/helper change rendered, without the enclave, chain signature, or publishing. Two forces
shape it:

1. **Zero-drift is non-negotiable.** The local render must produce what production produces, or the
   dev loop lies. A *forked/parallel* renderer is rejected (it drifts). The preview/action flow is
   the no-drift baseline.
2. **Fixtures aren't on chain.** The render action's orchestration does `fetchById(id, publicationModule, …)`
   — a **chain** lookup in `render/main.ts`. Anything not published to the contract can't be seen by
   the action path.

## The key finding that makes it work

`fetchById` / `getConfig` live in the **action orchestration** (`render/main.ts`), **not** in the
render core:

- `initTemplateData(…, templateConfig, body, …)` — takes `body` as an argument; only decrypts (when
  `body.encryption`) and unescapes. No fetch.
- `renderHTML(config, templateConfig, templateData, gateway)` — pure render from provided data.

**DECIDED 2026-08-10: the kit drives the *renderer layer* only, with local config + local data — not
the full action orchestration.** Resolving bodies is a data-source concern, not render-logic, and
that cuts both ways: the *publication config* is also a chain dependency we must *not* drag in.
`initTemplateData` needs `templateConfig` + `publicationModule`, and `renderHTML` needs `config` —
all chain-resolved via `getConfig`/`catFile(configCid)`. To see a *new* config/template in that
path you'd have to republish the config CID on chain — the wrong loop for iteration.

`website-starter` already keeps the config **locally**: `scripts/local-config-builder.ts` *builds* it,
and `templates/` + `mapping.json` are repo files. So the config is local by construction. The kit
imports the **renderer layer** — `html.ctrlr.renderHTML`, `handlebars.factory` + `handlebars-helpers`,
the content-transform stage (`transformContent`) as a pure function, and publication helpers — and
drives it with local config + local data/fixtures. It *skips only* the action's transport/decrypt/
sign (the part that wasn't local anyway). Zero drift on the render logic because it imports the
renderer functions rather than copying them; the bounded drift is limited to the decrypt/data-merge
layer, which preview covers (see Eval posture / two-tool split below).

## Data source (local-only)

The templating-only kit never touches chain, so its inputs are local by construction:

- **Local published content** — real `templateData`/bodies captured from the publication (exported or
  committed) as baseline data; renders the current site without any chain call.
- **Fixtures** — synthesized `S2SBody`/`templateData` for new / not-yet-published / experimental
  content a dev is templating against, and to probe the field variety the publication's
  helpers/templates touch (e.g. `filter_by_year` must be exercised against timestamps AND ISO AND
  `"2023-…"` `creation_date`). A fixture is just a local `body` with `encryption: false` fed into the
  renderer layer — no decrypt branch, same merge/render code.

Planned agent: a `publication-fixture-generator` that, given templates + helper specs + mapping,
emits the fixture set and keeps it honest as helpers grow. Anything encrypted stays a preview-time
concern (the enclave renders it); the local kit only ever sees plaintext fixtures/exported data.

## Eval posture / two-tool split

- **The kit is an *iteration* tool, preview is the *verification* gate.** The templating-only kit does
  not exercise encrypted-content decrypt or `initTemplateData`'s exact data merge, so it is not a
  byte-for-byte production oracle. That bounded drift is accepted: kit for the fast local loop,
  preview (the real action flow) for the no-drift check before publishing. This honors the
  zero-drift concern without forcing every template iteration through chain.
- **HTML string is the source of truth.** The render's deliverable is a string; verify it as code —
  diffable, assertable (`expect(html).toContain('<aside class="callout">')`), CI-able, byte-matching
  what ships. Do not couple correctness verification to a browser renderer.
- **Browser is the styling pass only** (layout, SCSS, responsiveness): render to files and serve them
  over the dev repo's `templates/` output.

## Decided direction (2026-08-10, rev 2): runner-driven dev render action (Option C)

**Rev 2 supersedes the import-based approach below.** The standalone-repo constraint kills it:

> **A publication dev has only the `website-starter` component locally — not `shared`, not
> `protocol`.** Confirmed by the `s2s-s3ntiment` fork's `package.json`: zero `@s2s/*` deps. The
> monorepo `website-starter` gets `@s2s/soul2soul-shared` only via `workspace:*` — a pnpm alias that
> resolves nowhere outside the monorepo. So the kit **cannot import** `@s2s/renderer/…` or
> `@s2s/render/content-transforms` (the PR #15 tsconfig-path-aliased imports resolve only inside the
> workspace). "Move to shared" doesn't fix it either — shared is also not present standalone, and
> publishing it would require extracting the renderer and making it compile standalone.

**DECIDED: an alternative *dev render action* driven through the Bun runner.** `runAction(preview=true)`
(`shared/src/rendering/helpers.ts`) already POSTs `{ cid, inputs }` to `S2S_RUNNER_URL`, which fetches
the action code by CID and executes it with the injected inputs — no Lit node, no workspace, no
monorepo source. The kit therefore needs only **two config strings** — `S2S_RUNNER_URL` + the
dev-action CID — and is standalone by construction.

**The dev render action takes ALL render inputs as injected `inputs`** — config/templateConfig (from
`local-config-builder`), local template/partial source, `mapping`, content bodies (pre-decrypted
plaintext), and extra publication-supplied helpers. No CID fetch, no `getConfig`, no `fetchById`, no
decrypt, no signature, no upload. This is what makes iterating on templates/helpers/mapping work
without republishing anything on chain — the same reason the config-on-chain dependency ruled out
the full core-import harness.

**Posture:** the dev action is a no-key, no-decrypt, no-sign pure renderer (injected plaintext in,
HTML out) — it carries none of the "verified code with key access" weight and never touches chain.
It is **additive** to the audited `protocol` bundle; the production render action is untouched.
**Zero-drift:** the dev action shares the SAME pure renderer core as production (one source, two
input-provisioning modes), so preview ≈ production by construction — no vendored copy, no published
package to version-lock.

**Killer feature:** helpers are injected as `inputs` source, so a dev edits a helper and re-renders
instantly — no `helpersCid` publish loop. The standalone kit becomes the exact place a publication
dev writes and tests helpers (RFC A Track 2).

> **Rev 1 (superseded): templating-only kit that imports the renderer layer.** Drive the renderer
> layer (handlebars engine, content-transform stage, publication helpers) with local config + local
> data by importing the pure functions. Rejected because the imports resolve only inside the
> monorepo workspace (standalone constraint above). Also rejected: the injectable data-access
> boundary inside the *production* action (touches the audited bundle, risks a preview/production
> behavioral split) — Option C's dev action is a separate additive artifact instead.

### How the extension points fit

- **Content transforms (RFC A Track 1)** — `transformContent` is a pure string transform; the kit
  applies it to the marked HTML before templating, same as the action.
- **Publication helpers (RFC A Track 2)** — helpers *are* templating code; the kit is the natural
  place a publication dev writes and tests them (`helpersCid`-equivalent local module merged into
  the helper map).

## Position vs. RFC A

RFC A = the runtime mechanism shipped in the enclave (content-transform stage now, `helpersCid` later).
RFC B = the local tooling + agent workflow that lets someone iterate on a publication's site. RFC B
consumes RFC A's seam (a registered transform/helper table) but is independent of its transport.

## Status

- [x] FetchById/config resolution — config-on-chain is the blocker; kit needs no chain
- [x] Standalone-repo constraint — a dev has only website-starter locally (no shared/protocol); import approach rejected
- [x] Decision — runner-driven **dev render action** (Option C): all inputs injected via `inputs`, driven through `S2S_RUNNER_URL`; additive to the audited bundle; shares the production renderer core
- [ ] **PR #16 merged by human** (also pending: merge **PR #14** quote-aware `sections` fix — still unmerged; main lacks it)
- [x] Standalone kit (Slice 2, `website-starter`) — **PR #17** (feat/standalone-render-kit, commit `78fcb1e`): `scripts/render-dev.ts` + `pnpm render:dev`, fixtures (`fixtures/bodies/{home,page,post}.json`, `all-deals.json`, `helpers.source`), README iteration loop. Gates: live-runner end-to-end **4/4** (home/page/post/demo — sections transform → `<section class="aside">`, titleCase+reverse helpers, shared collection filter all verified in output; 0 raw `<!-- section` markers); `tsc --noEmit` + `node --check` pass; existing scripts unbroken; lockfile churn = tsx entry only. Independent review **PASS no blockers**. Kit is standalone (only `node:fs`/`node:path`/`dotenv` + global fetch; zero `@s2s` imports) and drives the dev-action CID.
- [ ] **PR #17 merged by human** → full RFC B loop live: edit template/helper/fixture → `pnpm render:dev` → preview `pnpm serve` :3008
- [x] **Mode 3 — on-chain contract pull implemented (2026-08-11)**, now in the standalone
  `website-starter` repo (`github.com/Joera/website-starter`), branch `feat/cleanup-and-contract-render` @ `224d685`:
  new `scripts/contract-pull.ts` (zero `@s2s` — `ethers5` on Base L2/8453, inlined module ABI,
  paginated `getDeals`, IPFS `S2SContentItem` fetch, `toBody` mapping, drops `encryption===true`)
  + `render:dev --source=contract [--limit N]` routing pulled bodies through the **same** render-dev
  action into `html/` for `:3008` serve. Same branch bundled the **cleanup**: deleted 6 dead/orphan
  scripts (`abi.ts`, `fs.ts`, `ipfs.ts`, `local-config-builder.ts`, `pinata.ts`, `upload.ts`), dropped
  the `upload` script + `axios`/`form-data`/`@safe-global/*` deps, fixed `tsconfig.json` include
  (was blocking `tsc`), added `pnpm-workspace.yaml` so `pnpm install` exits 0. Independent review
  **PASS no blockers** (all gates live). Caveat: mode-3 happy path against a real content-bearing
  module is **not yet exercised live** — only the empty factory implementation was reachable from
  the sandbox; first real run needs a live `PUBLICATION_MODULE_ADDRESS`.

### TODO — block helpers (Track 2 forward work)

The renderer engine does **not** implement `{{#name}}…{{/name}}` block helpers — it skips the
`{{#…}}` form. Template authors must not design templates that depend on block wrapping /
iteration (`{{#featured}}…{{/featured}}`) until the engine grows real block-helper support.
This is a Track 2 (publication helpers) engine gap; when implementing the helper engine
(block helpers, a context/options arg, `{{log}}`/`{{inspect}}`), unblock this first. Recorded in
`website-starter/skills/template-design/SKILL.md` so agents authoring templates know the limitation.

### Post-merge hardening (non-blocking, from reviews)
- `extendHelperMap` mutates module-level `helperMap` statefully — snapshot + reset built-ins per render so helpers don't leak between renders in a long-lived process and names can't shadow built-ins.
- Precedence: document that `allDeals` overrides pre-built `collections` when both are passed; drop the dead `config` binding in `main.ts`.
- Standalone-install wrinkle — **RESOLVED (2026-08-11) by the repo re-org**: `website-starter` was
  extracted from the monorepo into its own repo `github.com/Joera/website-starter` (subtree split,
  branch `standalone-reorg`, pending main replacement) and the `@s2s/soul2soul-shared: workspace:*`
  dep was dropped there, so a bare `pnpm install` now resolves. The monorepo no longer contains
  `website-starter`; publication devs clone/fork the standalone repo (e.g. `~/code/s2s-s3ntiment`).
