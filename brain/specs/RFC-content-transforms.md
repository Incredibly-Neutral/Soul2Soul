# RFC — Render-time content transforms (section directives → HTML)

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

**In progress (Track 2):** publication-scoped template helpers injected into the PRODUCTION render
action. Decided shape (2026-08-12): the render action reads a helper-CID record off the **S2S Records
Module** (`configModule` — the Safe KV store that already holds the `config` record; NOT
`publicationModule`, which has no `getRecord`) via `getRecord('template_helpers_cid')` with
`rpcs?.L2` + `gateway`. If the record is missing (`KeyNotFound`/`EmptyKey`) the render degrades
gracefully to built-in helpers only — a missing record must never revert the render. If present:
`catFile` the CID, eval the module as a bare pure expression (`new Function('return (' + source + ')')`
— NOT the runner's `main()` contract, no runner globals/ethers injected), validate (plain object of
functions mirroring the built-in `{ name, helper }[]` contract, source-size cap, name-collision
policy with built-ins), merge via `extendHelperMap`, and audit-log the helper CID that ran. Run
**in-process, pre-sign**: no PKP key access, no network/`fetch` in the helper context. Because
`extendHelperMap` mutates the shared module-level `helperMap` (`handlebars.factory.ts:561,734`), the
merge must be **per-render scoped** (snapshot + reset built-ins each render) so helpers cannot leak
between publications or shadow built-ins in the long-lived runner process. Naming: record key
`template_helpers_cid` (snake_case, on-chain convention); optional `S2SPublicationConfig` field
`helpersCid` (camelCase, matching `assetsCid`/`templateCid`). The fetch-and-eval harness is
**trusted because it runs inside the audited, verified render action**, and every hop is
content-addressed (config → CID → `cat?arg=<cid>`) — byte-for-byte the trust model already used for
templates/partials: no new authority, no substitution vector. The dead `sections` mustache helper
is superseded by the stage.

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

**Track-2 convention (helpers — in progress):** the md→html **directive map** above is Track 1. Separately,
publication devs supply **template helpers** (e.g. `filter_by_year` — a blog-specific helper that exists in
`handlebars-helpers.ts` but is wired to no publication) as a named-function module fetched by `helpersCid`,
mirroring the built-in `{ name, helper }[]` contract, merged into the helper map before `processTemplate`
(`handlebars.factory.ts:561`). Trigger lives in the *template* (`{{filter_by_year 2023 posts}}`), so the
sections-style "no trigger" failure cannot occur. Engine gaps a real template dev wants: block-helper support
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

**Track-2 build state (2026-08-12):** production helper-injection feature code is **built and preserved** in the
s2s monorepo worktree worktree-pr/s2s-pub-helper-injection on branch `feat/render-pub-helper-injection` at
commit `082c954` (shared `renderer/helpers.ts`, per-render isolation primitives in `handlebars.factory.ts`,
production step + `resolveTemplateHelpersCid`/`injectPublicationHelpers` in `render/main.ts`, `helpersCid` on
`S2SPublicationConfig`, test file `render/helper-injection.test.ts`). PR not yet open. Root cause of the red
isolation tests is **confirmed**: (A) `processHelpers` (`handlebars.factory.ts:591`) requires ≥1 argument, so a
bare `{{name}}` resolves as a variable lookup (unknown → empty), not a helper invocation — engine semantics,
not a leak; (B) isolation test assertions self-collide (`not.toContain('P')` always fails via `DOCTYPE`, and
`not.toContain('A')` vs `toContain('{{helperA}}')` are mutually exclusive). Decision: for this PR, **fix the
tests** (assert isolation via arg-ful helper calls / map-state, fix collisions) and **do NOT** change the
renderer's bare-mustache semantics. Bare zero-arg helper invocation (`{{helperA}}` → invoke registered helper)
is a legitimate but **orthogonal engine enhancement** — attack as a separate follow-up with baseline-regression
care (29 baseline tests). Blocked pending recovery of the s2s-builder worker's auth backend (two consecutive
sessions hit a sustained 401 on all tools).
