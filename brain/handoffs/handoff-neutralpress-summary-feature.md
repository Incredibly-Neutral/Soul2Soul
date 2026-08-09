# Handoff: neutralpress content-summary feature (`<!--more-->` / `<!--split-->`)

**Date:** 2026-08-03
**Scope:** Design + exact change points for a WordPress-style summary/excerpt feature. **Investigation only — no code touched.** Ready for implementation.
**Status:** Design agreed with joera. Implementation pending (code change, not specs).

---

## What the feature is

Split a note's content into a **summary** + **content**, stored as `custom.summary`. Two modes via two in-content tags; no tag = no summary.

| Tag | Mode | `summary` = | `content` = |
|---|---|---|---|
| `<!--more-->` | excerpt | text **above** the tag | **full body** (tag stripped) |
| `<!--split-->` | partition | text **above** the tag | text **below** the tag |
| (none) | — | `undefined` (no summary) | full body unchanged |

- Both tags may coexist: `summary` = above the first of the two; `content` = below `split` (if present) else full body with `more` stripped.
- Tags are HTML comments → invisible in rendered output, survive `marked` MD→HTML and Obsidian round-trips. Verified live.
- No `<!--nextpage-->` — that's pagination, a separate feature (deferred).

## Why these names

- `<!--more-->` is the WordPress/SSG standard excerpt tag. Keep it.
- `<!--split-->` (partition) is our own — no WP standard exists for "summary + rest" because WP's `more` keeps the full body. `split`/`cut` clearer than reusing `nextpage` (which means pagination to anyone who knows WP).

## Storage: `custom.summary` (no schema/signing change)

`custom` is the per-publication extension bag and is **already wired end-to-end**:

- `S2SContentBody.custom?: Record<string, unknown>` — exists (`shared/src/protocol/types.ts:67`)
- `buildSignedContentItem` → `jcs(body)` auto-hashes it into `plaintextHash` — covered (`shared/src/identity/sign-content.ts:55`)
- `module.factory.ts:66-72` adapter passes `custom` through untouched
- `data.ctrlr.ts:86` → `custom: body.custom || {}` → `S2STemplateData.custom: any` → templates see `{{custom.summary}}`

**Zero new field, zero `S2S_TYPES` change, zero `buildSigningView` change.** That's why `custom` is the right home.

### Caveat (encrypted posts)

`custom` lives inside `S2SContentBody` → **encrypted with the body**. So `custom.summary` is NOT a public teaser for paywalled posts — it unlocks with the content. If a public feed teaser for encrypted content is ever wanted, that's a separate `S2SPublicContent.summary` (signed, queryable) addition — out of scope here unless joera escalates.

---

## Exact changes (code — not yet applied)

### 1. `neutralpress/src/content/content.ctrlr.ts` — derive summary in `parseNote`

After `mdContent = await marked(body)` + `distributeImages(...)` (around line 59-64), add:

```ts
const MORE = /<!--more-->/i;
const SPLIT = /<!--split-->/i;

function deriveSummary(html: string): { summary: string | undefined; content: string } {
  const moreIdx = html.search(MORE);
  const splitIdx = html.search(SPLIT);
  const cutIdx = [moreIdx, splitIdx].filter(i => i >= 0).sort((a, b) => a - b)[0];

  const summary = cutIdx >= 0 ? html.slice(0, cutIdx).trim() : undefined;
  const content = splitIdx >= 0
    ? html.slice(splitIdx).replace(SPLIT, "").trim()          // partition: below split
    : html.replace(MORE, "").trim();                          // excerpt: full body, more stripped
  return { summary, content };
}
```

Use it:
```ts
const { summary, content } = deriveSummary(mdContent);
// return `content` (replaces `mdContent`), add `summary` to the return object
```

### 2. Same file, `publishContent` — merge summary into `custom`

Before the `buildSignedContentItem` call (around line 126):
```ts
const custom = { ...(parsed.custom || {}) };
if (parsed.summary !== undefined) custom.summary = parsed.summary;
// pass `custom` into the body object (currently `custom: parsed.custom`)
```

### 3. ⚠️ Latent bug to fix alongside — `protocol/actions/src/render/data.ctrlr.ts:42`

`mergeDecrypted` (encrypted path) does:
```ts
custom: JSON.parse(decrypted.custom || "{}") || {},
```
This assumes `custom` is a **string**. The new publish path stores it as an **object** (`content.ctrlr.ts:126`). Today it doesn't fire because `custom` defaults to `{}`. **Adding `custom.summary` makes `custom` non-empty → the first encrypted post published via the new path throws** (`JSON.parse("[object Object]")`).

One-line fix:
```ts
custom: typeof decrypted.custom === "string" ? JSON.parse(decrypted.custom || "{}") : (decrypted.custom || {}),
```
Normalize on object (new path's shape). Legacy string storage (`note.factory.ts:286`) is the deprecated Lens path.

### 4. Templates (per-publication, IPFS-stored — NOT in repo)

- Listing cards / feeds: `{{{custom.summary}}}`
- Single view: `{{{content}}}`
- SEO/OG: `<meta name="description" content="{{custom.summary}}">`, `og:description`

Edited via each publication's template CID. Not doable from the repo.

---

## Verified facts (don't re-investigate)

- `marked` passes `<!--more-->` and `<!--split-->` through as standalone tokens between block elements (tested live with `neutralpress/node_modules/marked` v15).
- `buildSignedContentItem` body assembly: `jcs(body)` → `keccak256` → `plaintextHash` (`sign-content.ts:54-55`). Adding to `custom` auto-covered.
- `S2SContentBody = { title, slug, content, custom? }` (`types.ts:67-72`). `custom?: Record<string, unknown>`.
- `data.ctrlr.ts:42` (encrypted merge) + `:86` (unencrypted) both thread `custom` to `S2STemplateData` (`types.ts:155-172`).
- `module.factory.ts:40` adapter: `S2SContentItem` → legacy `S2SBody`; passes `custom` through.
- Render action still on legacy `S2SBody` shape (`render/main.ts:40` checks `body.id`). Consuming `custom.summary` couples to the deferred actions migration — but `custom` already reaches `templateData`, so no render-action change needed beyond the `mergeDecrypted` fix.

## Adjacent (not blocking, noted)

- `content.ctrlr.ts:113` sets `mediaType: "text/markdown"` but `parsed.content` is HTML (post-`marked`). Stored content is HTML mislabeled as markdown. Pre-existing; worth fixing in the same touch.

---

## Open decisions (joera's call — none blocking start)

1. No-tag fallback: **no summary** (current design) vs auto-excerpt (first N words). Joera leaned "just a feature" → no auto-excerpt. Confirm.
2. Frontmatter `excerpt:` manual override — include as top-precedence, or tags-only? Not discussed; default skip unless asked.
3. `mediaType` mislabel fix — bundle in or separate?

## Spec recording

Not yet recorded. Natural home: one contract row in `SPEC-00` (`custom.summary` convention + `more`/`split` semantics) + flow note in `SPEC-neutralpress` (the `parseNote` derivation point + `mergeDecrypted` bug flag). Deferred pending joera's go-ahead — he framed it as "just a feature," so may not warrant spec weight. Ask before writing.
