# SPEC-publication-look — templates, mapping, assets, and the build that turns a repo into a config

> **Parent:** [SPEC-publication](../SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-storage](SPEC-publication-storage.md) (where the rendered result
> lands), [SPEC-publication-admin-app](SPEC-publication-admin-app.md) (the button that runs the build).
> **The renderer that consumes this contract:** [SPEC-protocol-actions](../SPEC-protocol-actions.md).
>
> **Type:** component spec for the template kit and the config build, wherever the kit lives — it is a
> **standalone repo** (`github.com/Joera/website-starter`), not a monorepo package.
>
> **Audited against live code:** `website-starter` at `dde6b0f` (2026-10-29); builders at `85e9671`
> (2026-10-30).
>
> **Folded from:** `SPEC-website-starter` (all sections), plus the ripples-vs-collections section of
> `SPEC-protocol-actions` and the `mapping.json` verbatim gotcha from `SPEC-safe-app`.

---

## Responsibility

Owns **the contract between a publication's repository and its rendered site**: the mapping file, the
templates, the assets, and the build that turns a commit into a `S2SPublicationConfig` CID. It does not
own rendering (the press), the tokens on chain (the admin app proposes the write), or the tree (storage).

The governing rule: **the look is data in a repo, compiled to a CID, referenced by a record.** No part of
a publication's design lives in a database, a dashboard, or the app.

## The repository

| path | role |
|---|---|
| `mapping.json` | `templateConfig[]` + `ripples[]` — the whole wiring |
| `templates/*.handlebars` | one file per page type; `templates/partials/*.handlebars` |
| `assets/` | images, fonts, svg — copied to the site root as `/assets` |
| `scss/` → `css/` (or `assets/css/`) | styles, compiled **by the publisher, locally** |
| `fixtures/bodies/*.json`, `fixtures/all-deals.json` | dev-render inputs |
| `scripts/render-dev.ts`, `scripts/contract-pull.ts` | local render loop against the real renderer |
| `skills/template-design/` | the rules an agent authoring templates must follow |

The starter is cloned standalone and forked per publication. Nothing in it imports `@s2s/*` — that is a
hard constraint, not a preference, because the repo is what a publication dev actually holds.

## `mapping.json`

The starter's file, in full:

```json
{
  "templateConfig": [
    { "reference": "home",    "file": "home",    "path": "/",
      "collection": { "slug": "chapters", "filters": [{ "postType": "chapter" }], "sortBy": "position" } },
    { "reference": "chapter", "file": "chapter", "path": "/{slug}/",
      "collection": { "slug": "chapters", "filters": [{ "postType": "chapter" }], "sortBy": "position" } }
  ],
  "ripples": []
}
```

Four things about this file decide how a publication behaves:

1. **`reference` is the primary key, and it is unvalidated.** `getTaskConfig` matches it by exact string
   equality against `body.postType`. There is no registry and no schema check at build time. An item
   whose `postType` matches no reference renders **nothing, silently** — `prep` only pushes a job when a
   `templateConfig` with a non-null `file` was found.
2. **`path` is a template, not a literal.** `/` is the root page; `{slug}` is substituted per item *only
   when the item is not encrypted*. Everything else is literal. No locale prefix unless `localePaths`
   exists in the config.
3. **`collection`** (singular, in the starter) is the in-page data pull: fetch the publication's deals,
   match `filters`, sort by `sortBy`, inject under `slug` so a template can iterate
   `{{#each chapters}}`.
4. **`templateConfig[].filters` is dead.** The type has it, mappings write it, and nothing reads it —
   `grep` finds only `collection.filters` and `ripple.filters`. A mapping may carry it and it will never
   do anything.

`feedAddress` / `postId` (Lens-era fields) may still appear in older mappings. They are author-owned
residue: the builder passes `mapping` through **verbatim** and injects nothing.

## Ripples and collections are not the same mechanism

Frequently conflated; they compose but they are different.

| | collection | ripple |
|---|---|---|
| what | data pulled **into** a page while it renders | a rule that **other pages must be re-rendered** |
| declared on | `templateConfig.collection` | `ripples[]` |
| effect | the content of one page | additional *jobs* |
| example | the home page lists chapters | publishing a chapter re-renders home |

`S2SRipple = { origins[], destination, reference, query?, filters?, trigger_filters? }`.

- `origins` — the `postType`s that trigger it.
- `trigger_filters` — additional predicates on the *origin* item; all must match (`rippleFiresForBody`).
- `destination` — the `templateConfig.reference` used to render the cascaded page. **If it names a
  reference that does not exist, prep throws** (`ripple destination '…' not in mapping.templateConfig`) —
  the opposite of the silent-orphan behaviour for items.
- `filters` — destination-side selection, **not** consulted by the fire gate.
- `reference` — present in the type, unused by the current prep; treat as reserved.

**Ripples expand only when exactly one content id is rendered.** A bulk render skips cascade expansion,
so a batch publish does not re-render the pages that embed it. Intended as "a full render covers the
dependent pages"; a hazard if that assumption is wrong.

## Templates

Handlebars, compiled once per render, with the engine's own limitations:

- **Partials are textually substituted, not registered.** `replacePartials` replaces `{{> name}}` with the
  partial's source by regex, up to 10 nesting levels, then compiles. So **a partial cannot take
  arguments**, and a partial that is uploaded but never referenced is paid for and never read.
- **No custom helpers.** `if`, `each`, `with` are the only block forms; 30 inline helpers are built in
  (`extract_images`, `markdown`, `limit`, `slice`, `or`, `ifIn`, `unlessIn`, `explode`, `sluggify`,
  `stripHTML`, `formatDate`, `formatDateAsMonthYear`, `unique_years`, `filter_by_year`, `index_of`,
  `prevNext`, `json`, `log`, `concat`, …). `(eq a b)` works only inside `{{#if (eq …)}}`. Any other
  `{{#name}}…{{/name}}` is **silently skipped**. Publication-supplied helper code is impossible, not
  missing: `eval`/`new Function` are CSP-blocked in the enclave, dynamic `import()` is rejected by Lit's
  bundler, and per-publication action builds were rejected by decision.
- **Content transforms run before the template does.** `transformContent` (in the action, not the repo)
  rewrites `<!-- section class="aside">…<!-- /section>` into `<section class="aside">…</section>` on the
  decrypted plaintext, so stored content stays raw and a transform change needs only a re-render.
- **Newlines are stripped from template sources at build time** (`content.replace(/\n/g, '')`). A `//`
  comment in an inline `<script>` therefore comments out the rest of the file.

## What a template receives

Per item, a flattened object: `id` (genesis), `cid`, `objectId`, `plaintextHash`, `specVersion`,
`mediaType`, `proof`, `author` (`did:ethr:0x…`), `locale`, `parent`, `position`, `postType`,
`publication`, `base`, `creationDate`/`modifiedDate`, `tags[]`, `attributes{}`, `title`, `slug`,
`content`, `custom`, `encrypted`.

The distinction that matters: **`attributes` is signed public envelope** (visible even for encrypted
items), **`custom` is body** (secret when encrypted). A byline from `attributes.author_name` leaks
nothing; `custom.author_name` renders nothing for an encrypted item.

Plus `collections` — one entry per `slug`, each a list of the same flattened shape, decrypted where the
press is allowed to. No pagination, no tag index, no search.

## Styles

SCSS is compiled **locally by the publisher** (`npm run sass`) into `assets/css/main.css` and committed.
The press compiles nothing. Root-absolute `/assets/css/main.css` works because each page is served from
its own origin (`https://<cid>.preview.transport-union.dev`, `https://<name>.link`) — invariant INV-11,
and the reason a path-gateway URL in content breaks a site.

## From repository to config

`ConfigBuilder.buildConfig(github_account, repo, branch, publicationName, contractAddress, assetsCid,
existingConfigCid?, domain?, aliases?)` lives in `shared/src/publication/config-builder.ts`:

1. load the existing config by CID (this is how `aliases` and `localePaths` survive);
2. `AssetsBuilder.buildAssets` → `assetsCid` (`js/` and `css/` always re-read from GitHub;
   `fonts`/`img`/`svg` reconciled against the previous `assetsCid`'s child map);
3. walk `templates/` via the GitHub contents API, strip newlines, add each to Kubo, `dagPut` a dag-json
   array with real IPLD `link` fields → `templateCid`;
4. read `mapping.json` at a **pinned commit SHA** (`raw.githubusercontent.com/<owner>/<repo>/<sha>/…`);
5. mirror the config to Filebase + Pinata (fire-and-forget) and pin the templates DAG by CID;
6. assemble and `add` the final config to Kubo — its CID is the one that goes on chain;
7. one `setRecord('config', <cid>)` proposal.

**Commit-pinning hole:** the mapping is read at a SHA resolved *after* the template walk, while templates
came through `download_url` at listing time. A commit landing between the two yields a config whose
mapping names a file the `templateCid` lacks — failing at render time, on one page, with
`template file not found`.

**A config update with no render changes nothing observable.** Only a render writes the ENS root.

## `S2SPublicationConfig`

```ts
interface S2SPublicationConfig {
  assetsCid: string; contract: string; dataGateway: string;
  mapping: { templateConfig: S2STemplateConfig[]; ripples: S2SRipple[] };
  name: string; templateCid: string;
  localePaths?: Record<string, string>;
  domain?: string;            // legacy single write target
  aliases?: string[];         // additional names kept pointed at the root
}
```

A recipe plus pointers: no titles, no content, no HTML. An earlier revision carried `helpersCid` — a
pointer to publication-supplied helper code — dropped with the injection path it existed for. Old configs
still parse; the field is ignored.

Alias precedence: explicit `aliases` → explicit `domain` (as `[domain]`) → carried-forward `aliases` →
carried-forward legacy `domain` **promoted** to `aliases`. An empty array clears every write target.

## Invariants

- **INV-11** — templates emit root-absolute paths; pages are served origin-per-CID. Never bake a
  `/ipfs/<cid>` URL into content or a template.
- **The mapping is author-owned.** The builder passes it through; injecting publication-specific values
  silently is a do-not-touch until decided explicitly.
- **One renderer.** `render-dev` and production run the *same* action code; the repo carries no second
  renderer.
- **The look is in the repo or it is nowhere.** No app-side design state.

## Safe-to-change vs do-not-touch

- 🟢 templates, partials, SCSS, assets, the README (the starter has none — highest-value fix for
  adoption); add a mapping schema check at build time; prune the dead `templateConfig.filters`.
- 🔴 the `mapping.json` structure, the partial/helper names and `collections.<slug>` shape the renderer
  expects, the root-absolute convention, and the `reference` ↔ `postType` equality rule (changing it
  invalidates every existing mapping).

## Test seams

- Render a fixture `template + mapping.json + templateData` through the dev render action → assert HTML.
  This is also the parity check.
- Lint `mapping.json` against the shared zod `mappingSchema` before build (not currently done at build).
- Orphan item with an unknown `postType` → zero jobs, no error. Orphan ripple destination → throws.
- A template with a `//` comment inside `<script>` → truncated output (assert the failure mode exists so
  nobody debugs it twice).
