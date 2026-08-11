# Designing Templates for a Publication

This skill is for an agent that designs and iterates on templates for a publication site
built from `website-starter` (e.g. `~/code/s2s-s3ntiment`). It explains the render pipeline,
the two authoring conventions, and the `render:dev` iteration loop so you can design
templates, partials, helpers and content directives that actually work.

## The mental model

A publication site is a **static site generated from templates + data**. The render pipeline is:

1. **Content** — markdown bodies and collections (posts, deals, etc.).
2. **Transform** — markdown → HTML, then a content-transform stage turns authoring directives
   (`<!-- section class="aside">…`) into real HTML elements at render time. Stored content stays raw.
3. **Template render** — the Handlebars-style engine fills `templateData` into the publication's
   templates + partials, running helpers.
4. **Output** — `html/*.html` served for preview (default `:3008`).

There are **two distinct authoring surfaces** — keep them separate:

| Surface | Trigger lives in | Convention | What you author |
|---|---|---|---|
| Content directives | the markdown body | declarative comment markers | `<!-- section class="aside">…` |
| Template helpers | the template itself | named-function module | `{{filter_by_year 2023 posts}}` |

## The iteration loop (render:dev)

```
pnpm render:dev
```

Gathers local `templates/` + `partials/` + fixture bodies + the helpers source, POSTs them to
the remote Bun runner (which runs the **same pure renderer core** the production action uses),
and writes `html/*.html` for the `:3008` serve preview.

- Edit a template / partial / fixture body / helpers source → re-run `render:dev` → see the
  HTML. No chain, no decrypt, no publish.
- **Zero drift**: preview renders through the same renderer core production uses, so "what I
  preview" = "what ships".
- The kit is standalone: no `@s2s/*` deps, only Node builtins + `fetch`; works in a fork like
  `~/code/s2s-s3ntiment`.
- Render is over the network (`S2S_RUNNER_URL`, default `https://run.transport-union.dev/run`,
  env-overridable). If it's unreachable, the run fails and tells you.

## Authoring content directives (md → html)

Grammar:
```
<!-- section class="aside">  →  <section class="aside">
<!--section>                 →  <section>            (no space, no attrs)
<!-- section -->             →  <section>
<!-- /section>               →  </section>
```
Rules:
- Space after `<!--` optional (`<!-- section` and `<!--section` both work).
- Attributes pass through **raw** — `class="aside"` lands on the element; quoted values may
  contain `>` or `-->` and are handled correctly.
- Closers may be `>` or `-->`.
- The built-in `sections` transform is the first entry in a directive table; publication-specific
  directives extend the same mechanism.
- Directives fire on **rendered HTML** (post-markdown), so they live in the markdown body, not
  in templates.

## Template helpers

Called **by the template** with mustache syntax: `{{helpername arg1 arg2}}`.
- Quoted args stay strings; bare tokens resolve as context values (`{{filter_by_year 2023 posts}}`
  passes the real `posts` collection).
- A missing/typo'd helper returns the raw `{{...}}` unchanged; an erroring helper returns `""` —
  neither is loud, so verify output rather than assuming the page is right.

Built-ins exist for common needs (date, slice, slugify, trim, …). **Publication-supplied
helpers** are a named-function module injected into the render — they **extend** (not replace)
built-ins. In this kit you author them in `fixtures/helpers.source`:

```js
({
  filter_by_year: (year, posts) => { /* … */ },
  featured_only: (posts) => posts.filter((p) => p.featured),
})
```
Rules for that file:
- It must be a **bare JS expression** with **no trailing semicolon** — the action wraps it as
  `return (SOURCE);`. That's why it's `.source`, not `.js` (prettier/editors add a `;` and would
  break the eval).
- Keep helpers **pure** (no I/O, no side effects) — they run inside the action.

A helper like `filter_by_year` is the canonical "logic a publication owns" — it belongs in the
publication's helper module, not hardcoded in the renderer.

## Data available to templates

- **Body** — `S2SBody`: `content` (markdown/plaintext), `title`, `slug`, `custom` fields.
- **Collections** — e.g. `posts`, `allDeals[]` — filtered through the publication's collection
  filters (e.g. `featured`).
- **Config** — `mapping`, `templateCid`, and the directive/helper extension points.
- **Fixtures** — `fixtures/bodies/*` (plaintext, `encryption:false`), the local stand-in for
  content you iterate against.

## Design guidance

- **Design helpers against the data shape + field variety**, not fixed data. `filter_by_year`
  breaks if fixtures only hold ISO dates and the real publication mixes formats — vary the
  fixture fields your helpers touch.
- **Block patterns** (`{{#featured}}…{{/featured}}`) are a **known engine gap** — the engine
  skips `{{#…}}`. Don't design templates that depend on them yet (see SPEC/RFC TODOs).
- **Verify as HTML strings** — the renderer's deliverable is an HTML string; assert on that
  (greppable, diffable), and use the browser only for visual/styling passes (SCSS, layout).
- **Prefer declarative over code**: content directives are data; reach for a helper only for
  real logic (filtering, sorting, formatting).

## Where things live

- `templates/` — page templates (`home`, `page`, `post`).
- `templates/partials/` — reusable template fragments (`background`, `head`, `header`, `logo`, …).
- `scripts/local-config-builder.ts` — builds the local publication config.
- `scripts/render-dev.ts` — the `render:dev` loop.
- `fixtures/bodies/*` — local plaintext content fixtures (`home.json`, `page.json`, `post.json`).
- `fixtures/all-deals.json` — the collection data source.
- `fixtures/helpers.source` — the injected publication helpers module (bare expression, no `;`).
- `html/` — **generated output** (safe to wipe; it's the render target).

## Expand later

Starting point. Future additions: block-helper support, a `{{log}}`/`{{inspect}}` debug helper,
the full directive-table schema, and publication-specific helper conventions as they stabilize.
