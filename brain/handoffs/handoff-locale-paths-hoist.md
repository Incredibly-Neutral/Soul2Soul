# Handoff — localePaths never reaches the renderer (en path prefix missing)

Date: 2026-08-17
Status: in implementation (PR opened by s2s-builder from `feat/locale-paths-hoist`)

## Reported bug
When publishing a post of type `why` with language `en`, the rendered path does
not contain `en` (expected `/en/<slug>/`, observed `/<slug>/`).

## Root cause (confirmed by explore, commit 31f0428 era)
`createPath` (`protocol/actions/src/render/data.ctrlr.ts:12`) derives the locale
prefix from `config.localePaths[body.locale]`. The renderer passes
`config.localePaths` into template-data building (`render/main.ts:72`). But
**both config builders rebuild the published config and never emit a top-level
`localePaths`**, so at render time `config.localePaths` is `undefined` → prefix
`''` → no `en`.

The user's mapping.json DOES declare `localePaths`
(`{default:'', nl:'', en:'/en'}`), but both builders dump the whole mapping
object into `config.mapping` and nothing into `config.localePaths`, so the map
sits at `config.mapping.localePaths` — invisible to createPath.

Builders affected:
- `shared/src/publication/config-builder.ts` ~226-233 (finalConfig = six fields)
- `neutralpress/src/publication/config.ts` createConfig ~252-267 (same six)

`body.locale` is NOT the problem: it is set at publish (`content.ctrlr.ts:112
locale = frontmatter.language || 'en'`), signed into `S2SPublicContent.locale`,
persisted in the IPFS payload, and re-fetched by fetchById → toBody — it is `en`
at render.

## Secondary, independent bug — language vs locale filter drift
The user's home_nl/home_en collection filters key on `language`
(`{"postType":"why","language":"en"}`), but no body/collection item carries a
`language` field — the canonical signed field is `locale`. `filterCollection`
does exact match, so `item['language']` is undefined → home_en/home_nl `why`
collections are ALWAYS EMPTY, and the standalone `why` collection (no language
filter) blends nl+en. Ripples already key on `locale` (correct), so they
re-render home_en but with an empty collection.

**Config-only fix (user's external mapping.json, not repo code):** change
`language` → `locale` in the home_nl/home_en collection filters. This is exactly
the drift warned about in `brain/specs/SUMMARY-protocol.md:136-139`.

## Fix being implemented
Builder-side hoist only (minimal, scoped): add top-level
`config.localePaths = mapping.localePaths` in BOTH builders, plus a regression
test in `shared/src/publication/config-builder.test.ts` asserting localePaths
survives. Renderer unchanged (it already reads config.localePaths). Requires a
config re-upload (new config_cid) after deploy; if the pinned render action
predates 31f0428 it must be re-pinned too.

## RESOLUTION / DEPLOYMENT CHECKLIST (2026-08-17)
- PR #32 (merge 8dcb5d2 -> 5149deb) is MERGED on GitHub main (merged 10:31Z).
- Render action confirmed locale-aware: fetched pinned CID QmcxBpj8… from the
  transport-union gateway; it contains `createPath` with the exact 31f0428
  `localePaths[body.locale] ?? localePaths.default ?? ''` logic and reads
  TOP-LEVEL `config.localePaths` (2 hits, 0 for mapping.localePaths). So NO
  render re-pin is required — the renderer is not the problem.
- POST-MERGE GOTCHA (how "no effect" happened): the user's LOCAL main was still
  at 9a33596 (pre-fix), so local plugin/builder builds were the OLD pre-fix
  builder → rebuilt config still had `localePaths` only nested at
  `config.mapping.localePaths`, never top-level. Local main has since been
  fast-forwarded to origin/main (9427205) so subsequent local builds include
  the hoist.
- Remaining deployment steps for the user:
  1. Rebuild neutralpress plugin / shared builder from the CURRENT local main.
  2. Re-run config build+upload; verify the built config JSON has TOP-LEVEL
     `"localePaths"` (alongside assetsCid/contract/dataGateway/mapping/name/
     templateCid) — the decisive check.
  3. Ensure rendering is pointed at the NEW config_cid (render loads config by
     the publication's configCid; if it still points at the old config the fix
     is moot).
  4. If config now has top-level localePaths but the path STILL lacks /en/, the
     on-chain render action is the culprit: `update-protocol.ts`'s Safe
     multisig re-pin must be confirmed by owners (chainId 8453). The pinned
     config.json record (QmcxBpj8) is locale-aware, but the on-chain PKP may
     still reference an older render CID until the Safe tx confirms.
- DISAMBIGUATING TRACE: a fresh rendered trace's config (index 1) + job.path
  tells which remains: no top-level config.localePaths => stale builder/code;
  top-level present but path unpRefixed => on-chain render action (Safe pin).

## Latent issue spotted (not in scope of this fix)
Encrypted collection items get no `path` (`render/main.ts` decrypt branch omits
`item.path = pathsForCollections(...)`; only the plaintext branch sets it).
Not hit today (content.ctrlr uses noOpEncrypt) but latent.
