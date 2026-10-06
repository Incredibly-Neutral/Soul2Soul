# Handoff — Header EN/NL language switcher

Date: 2026-09-02. Repo: `~/code/s2s-s3ntiment` (website-starter clone; the human's
"s2s-sentiment").

## What shipped

Refactor of the shared header partial to add an EN/NL language switcher, positioned
right of the main nav at the far right of the header (layout: logo | nav | lang-switcher).

- **`templates/partials/header.handlebars`** — new `.lang-switcher` div (sibling after
  `</nav>` inside `.container.container-large`):
  - `{{#if (eq locale 'nl')}}` → `<a class="lang-cell" href="/">EN</a>` +
    `<span class="lang-cell active">NL</span>`
  - `{{else}}` (en) → `<span class="lang-cell active">EN</span>` +
    `<a class="lang-cell" href="/nl">NL</a>`
  - Driven by `{{locale}}` (canonical field — NOT `language`). Only `{{#if}}/{{else}}`,
    no block helpers.
- **`scss/partials/header.scss`** — `.lang-switcher` bordered flex group (1px black
  border), two 2rem `.lang-cell` squares side by side; inactive = white bg / black text,
  `.active` = black bg / white text (yin-yang contrast); `margin-left: 1rem`,
  `flex-shrink: 0`.
- Compiled `assets/css/styles.css` + `.css.map` via `pnpm sass`.

Homepage mapping used (from `mapping.json` `localePaths`): `nl -> /nl`, `en/default ->
''` → EN home `/`, NL home `/nl`. The inactive square links to the other language's
homepage; the active square is a non-link span.

## Gates (all green, re-run by orchestrator)

- `pnpm render:dev` — 4 renders OK (home/page/post/why).
- `html/home.html` (NL): exactly one active — `<a class="lang-cell" href="/">EN</a>` +
  `<span class="lang-cell active">NL</span>`.
- EN branch (temporary `fixtures/bodies/home.json` locale → `en`, reverted): `<span
  class="lang-cell active">EN</span>` + `<a class="lang-cell" href="/nl">NL</a>`. No
  fixture residue.
- `pnpm sass` — clean compile.

## PR

https://github.com/Joera/s2s-s3ntiment/pull/2 — branch `header-lang-switcher` → `main`.
**Not merged — human merges.** Commit `fbd1cf8` (only header.handlebars + header.scss +
compiled css; no mapping.json / scripts / helpers.source / fixtures).

## Review (independent pass)

Verdict: approve. Contract items 2–6 pass. Item 1 flagged as a verification gap
(`home_en` consumer), closed with evidence: `home_en.handlebars` uses `{{locale}}` and
includes `{{> header}}`; the else branch renders there structurally (render:dev's local
specs in `scripts/render-dev.ts` have no `home_en` config — pre-existing kit limitation,
see skills). `(eq locale 'nl')` is a pre-existing, shipping construct already on `main`
in the same file (logo + nav links), and the differential NL/EN gate proves it resolves.
Non-blocking nits only: a stray pre-existing blank line in `header.scss` near the new
block (cosmetic, left as-is); optional `aria-label`/`lang` attributes on the two squares
for accessibility (not in contract — candidate follow-up if desired).

## Notes for next runs

- render:dev cannot exercise the EN homepage template (`home_en`) — only home/page/post/why.
  For EN-branch template verification, temporarily flip `fixtures/bodies/home.json`
  `locale` and revert (as done here).
- The `(eq locale 'nl')` subexpression helper is used widely already; treat `eq` as a
  proven engine built-in for this codebase.
