# RFC-006 — render-time content transforms (section directives → HTML)

> Domain: `PRESS` · moved from `brain/specs/RFC-content-transforms.md` (2026-11-04); number assigned on the move.

> **Type:** settled design decision + forward seam (an RFC, not a spec). Records the decision that
> content-embedded HTML directives are transformed at **render time** on the decrypted plaintext
> content — **not** via a Handlebars mustache helper — and that the transform is a pluggable
> content-transform stage whose built-in `sections` transform is the seed of a future
> publication-supplied helper.
>
> **Origin:** joera direction (2026-08-10). Investigation: the `sections` mustache helper
> (`protocol/actions/src/renderer/handlebars-helpers.ts:555`) never worked. Root causes: **zero
> call sites** (mustache helpers only fire on `{{…}}` template syntax; no template ever calls
> `{{sections …}}` — the directive lives in the *markdown body*, so a pure helper can never see
> it); a regex that requires a `{...}` JSON block after `section` and `-->` closers (the authored
> syntax is `class="aside"` attributes with `>`/`-->` closers); and **no post-render transform
> stage**. Compare the one content helper that *does* work — `extract_images` — which is explicitly
> invoked at `website-starter/templates/post.handlebars:19`.

---

## Decision

Transform the directive at **render time**, on the decrypted plaintext content, exactly where
`templateData.content` is built in `initTemplateData` (`protocol/actions/src/render/data.ctrlr.ts`
— the returning object's `content:` line):

```ts
content: (body.content || '').replace(/\\n/g, '\n').replace(/\\\"/g, '"').replace(/\\\\/g, '\\'),
```

**Why render time, not publish time:** stored/decrypted content stays **clean and raw** — never
bake directive output into the stored artifact, never mix markdown-authoring output into stored
content. Transform changes take effect on re-render without re-publishing. It runs before any
template logic and is **independent of template call sites** — which is what structurally fixes the
"no trigger" failure (the body is transformed regardless of whether a template author remembers to
call `{{sections …}}`).

**Why not a mustache helper:** a helper only fires when a template author writes `{{sections …}}`;
the directive lives in the markdown body, so a pure helper can never see it. The helper can at
best *coexist*; it is not the mechanism.

**Where not to do it:** after `processTemplate` returns on the whole page (`factory.ts:681` /
`html.ctrlr.ts` post-process) — re-scans the whole rendered document, touches non-content regions,
and runs after template-level helpers like `extract_images`.

---

## The built-in transform: `sections`

- Accepts both `<!-- section` and `<!--section` (the space is optional).
- Attributes pass through **raw as a string**: `<!-- section class="aside">⋯<!-- /section>`
  → `<section class="aside">⋯</section>`.
- Attribute-less `<!-- section>` → `<section>`.
- Tolerates a `-->` **or** `>` closer on both opener and closer (`<!-- /section>` / `<!-- /section -->`).
- Only the `section` tag is handled; everything else passes through unchanged.

---

## The stage (pluggable seam)

Implemented as a **content-transform stage** — a pure string-in/string-out unit — with the
`sections` transform as its built-in default and a registered/typed seam for additional transforms.
This is the **inline version** of what can *ultimately* be fetched from publication source.

**ABANDONED (2026-08-13): Track 2 — publication-helper injection into the PRODUCTION render action is
DEAD. Do not resurrect without revisiting the hard constraints below.**

**Why runtime code import is impossible in a Lit action** — verified live, not conjectured:
1. `new Function` / `eval` — CSP-blocked in the Lit signing enclave (Chipotle/Deno sandbox):
   "Code generation from strings disallowed for this context" (observed on `s3nl.soul2soul.eth`).
2. dynamic `import()` — blocked by Lit's own bundle step: "Failed to bundle CDN imports: scanning
   entry for literal dynamic imports" (`src/actions/client/execution.rs:146`) (observed live).
3. Actions are **immutable + content-addressed (IPFS CID)**; the PKP signs *iff* the executed CID is
   in the group's permitted set (SPEC-00 §2.1, INV-8). Per-render assembly/mutation of the submitted
   code text is impossible (unpermitted CID → enclave rejects), PKP aside.

**The only workaround** that keeps helpers executing inside the enclave would be **per-publication
render-action builds** (bake a publication's helper module into its action via Lit's permitted external
loader). **Decision: we are NOT doing render actions per publication** — the shared, immutable render
action model stands. Therefore the idea is dead.

**What replaced it (PR #24, `cleanup-helper-builtin`):** the runtime injection path was **removed**
(injection/eval/import code deleted; production renders with built-in helpers only, graceful no-op);
`prevNext` (circular ring/wrap nav) was added as a **built-in** helper in `handlebars-helpers.ts`
(13 tests, driven through the real renderer with `{{{prevNext collections.why position}}}`);
`helpersCid` was dropped from the config build/type. `templateCid`/`assetsCid` untouched. In-flight PRs
tied to the dead path (#22 config-only simplify, #23 eval→import) are closed / not merged. The local
dev-loop helper iteration in `website-starter` (Bun runner, helpers injected as `inputs` source) remains
the place helpers are authored/tested — but they cannot be injected into the enclave render. The Track-1
content-transform stage is unaffected.

**Lit static-import capability (jsDelivr, 2026-08-13) — noted, not pursued.** Lit Actions can now
statically `import` third-party ESM packages from jsDelivr at version-pinned specs with SHA-384
integrity verification (TOFU + SRI, `integrity.lock` / inline `#sha384-`, no redirects, ≤10 MB, cached).
This is a *different* mechanism from the two blocked paths — a **static** import written into the action
source (baked into the immutable CID), not runtime eval / dynamic import. It does **NOT** revive
per-publication helpers: a shared render action has one fixed import set at build time for all
publications — the same shared model as the built-ins above, only a cleaner distribution form (publish
an `@s2s/lit-helpers`-style package and import it). **Decision: for now there is no point in splitting
the render action into parts** (no per-publication / modular action split); the unified shared action
stands. Extracting shared helpers to a published package would be a maintainability refactor, not a
return to dynamic injection, and is parked until needed. (If ever pursued: our `build-actions.cjs`
esbuild IIFE must mark jsDelivr bare imports `external` and leave them literal so Lit resolves them at
runtime — consistent with compaction/upload.)

---

## Related forward work

**Local rendering vs. encrypted data.** The local renderer (`website-starter`, now its own standalone
repo `github.com/Joera/website-starter` since 2026-08-11) only ever sees the data a
dev can hand it. For fully-public publications that is near-real data; for **collective publications** with
cooperating authors where some content is encrypted, a local dev cannot see the encrypted fields and works
against **synthesized dummy `S2SBody` fixtures** instead. The seam that keeps this honest is the **data
shape, not the data**: the enclave renders `templateData` from a decrypted body, the local dev renders the
same shape from an `encryption:false` dummy — same engine, same helper contract.

**LLM-authored fixtures are the intended mechanism** for generating these dummies: `S2SBody`/`S2SContentItem`
is well-defined, so fixtures are generated *to the schema* and *to probe the field variety the publication's
helpers/templates actually touch* (e.g. `filter_by_year` must be exercised against timestamps AND ISO AND
`"2023-…"` `creation_date` strings). Fixtures should therefore be generated **publication-aware +
helper-aware** — read which fields the templates/helpers reference, synthesize variety across exactly those.

**Planned owner:** a dedicated agent config (non-code scaffold) that, given a publication's templates +
helper specs + mapping, emits publication-specific dummy `S2SBody` fixtures / `templateData` snapshots for
local render, and keeps them honest as helpers grow. Tracked with the Track-2 helper mechanism; see the
Track-2 convention note below.

**Track-2 convention (helpers — ABANDONED, see above):** formerly the md→html **directive map** (Track 1)
was complemented by publication-supplied **template helpers** (e.g. `filter_by_year`). As recorded in the
ABANDONED section, that production path is dead (Lit cannot import code at render time; we are not doing
per-publication render actions). Helper logic now lives as **built-in helpers** in `handlebars-helpers.ts`
(e.g. `prevNext`); the local dev kit (`website-starter`) remains the authoring/testing surface. The
fixture-generator agent below is **separate** — it scaffolds local `S2SBody`/`templateData` fixtures for
the dev kit's render loop (which still works), independent of the dead production injection path.
Engine gaps a real template dev wants: block-helper support
(`{{#name}}…{{/name}}` — currently skipped), a surrounding-context/options arg, a `{{log}}`/`{{inspect}}`
debug helper, and clear error surfacing (not silent `""`). Same pre-sign / no-key / no-network / audit-log
posture as the transform stage.

**RFC split:** this file is **RFC A** — the runtime enclave mechanism (content transforms + helper
injection). The developer tooling side (local render harness, hybrid real-on-chain + fixture data, the
`fetchById`-vs-fixtures resolution, HTML-as-source-of-truth eval, agent workflow on `~/code/s2s-s3ntiment`)
is tracked separately in **`RFC-website-starter-agent-kit.md` (RFC B)**.

## Status

- [x] Investigation — root cause + hook point confirmed
- [x] Decision — render-time (Option B), pluggable stage
- [ ] Implementation + PR (dispatched)
- [ ] Fold settled parts into `SPEC-protocol-actions` / `SPEC-shared` / `MAP.md` when merged

**Track-2 build state — SUPERSEDED / ABANDONED (see the ABANDONED Track-2 section above):** historical
documentation of the now-dead runtime injection path (branch `feat/render-pub-helper-injection`, PR #18,
commit `082c954`) follows for the record only. The entire mechanism was removed by **PR #24
(`cleanup-helper-builtin`)** — production renders with built-in helpers only, `prevNext` became a
built-in helper, and `helpersCid` was dropped from the config build. Treat everything below as history,
not the plan. Historical detail (retained verbatim): `feat/render-pub-helper-injection` at
commit `082c954` (shared `renderer/helpers.ts`, per-render isolation primitives in `handlebars.factory.ts`,
production step + `resolveTemplateHelpersCid`/`injectPublicationHelpers` in `render/main.ts`, `helpersCid` on
`S2SPublicationConfig`, test file `render/helper-injection.test.ts`). **PR #18 open** @ HEAD `1eb39ea` (amended single clean commit), base main — 52/52 protocol tests green (baseline 29, feature +23, verified by orchestrator), tests-only isolation rewrite at the state seam, no product-code change vs the feature commit, no lockfile churn. **Independent review clean (no blockers):** reviewer verified isolation-at-the-state-seam, graceful missing-record degrade, built-ins-win collision, loud-failure for broken helpers, bounded eval + CID audit, shared pure module reused by render-dev, no new deps. The one flagged verification gap (does a non-empty `errors` → `ok:false`) was **confirmed by orchestrator** at `render/main.ts:300` (`if (errors.length>0) return { ok:false, error: errors.join('; ') }`) — loud failure holds. Non-blocking follow-ups noted (not folded per user preference): trace array mixes string/object entries; `injectPublicationHelpers` is exported but not self-scoping (a future caller could forget the snapshot/finally and re-leak — consider encapsulating snapshot→inject→reset into one primitive); NITs (`.ts` import extension, `injected:true` when `merged:0`, `gateway!`, defensive `typeof` in merge). Root cause of the red
isolation tests is **confirmed**: (A) `processHelpers` (`handlebars.factory.ts:591`) requires ≥1 argument, so a
bare `{{name}}` resolves as a variable lookup (unknown → empty), not a helper invocation — engine semantics,
not a leak; (B) isolation test assertions self-collide (`not.toContain('P')` always fails via `DOCTYPE`, and
`not.toContain('A')` vs `toContain('{{helperA}}')` are mutually exclusive). Decision: for this PR, **fix the
tests** (assert isolation via arg-ful helper calls / map-state, fix collisions) and **do NOT** change the
renderer's bare-mustache semantics. Bare zero-arg helper invocation (`{{helperA}}` → invoke registered helper)
is a legitimate but **orthogonal engine enhancement** — attack as a separate follow-up with baseline-regression
care (29 baseline tests). Blocked pending recovery of the s2s-builder worker's auth backend (two consecutive
sessions hit a sustained 401 on all tools).
