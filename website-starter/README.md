# website

Website-starter publication templates, styles and local render tooling.

## Local render kit (RFC B — templating-only)

`render:local` renders the handlebars templates in `templates/` against LOCAL data
(fixtures in `data/` + local config from `mapping.json`) and writes the result into
`html/` — no chain, no gateway, no decrypt, no signature. It reuses the renderer
layer's pure functions by import (`protocol/actions/src/renderer/handlebars.factory`,
`.../render/content-transforms`) and only swaps the template SOURCE (local files
instead of gateway CIDs).

Scripts:

- `pnpm run render:local` — render all pages into `html/` (idempotent).
- `pnpm run render:local:verify` — self-contained smoke test asserting invariants
  on the rendered output (markdown->HTML + content-transform applied).
- `pnpm run render:local:typecheck` — strict `tsc --noEmit` scoped to website-starter
  source (scripts/ + data/); see the script header for the rationale around the
  renderer's pre-existing strict violations.

Preview:

- `pnpm run sass` — build `css/styles.css` from `scss/`.
- `pnpm run serve` — `http-server html -p 3008`; serves the rendered output from the
  previous `render:local`.

Content bodies in `data/fixtures.ts` are stored raw (markdown). At render time the
kit applies `marked` (markdown -> HTML) then the content-transform stage
(`transformContent`, RFC A) before templating — matching the render action's
render-time pipeline.
