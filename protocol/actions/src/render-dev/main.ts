/**
 * Dev render action (RFC B, Option C) — the protocol-side "render-dev" action.
 *
 * A pure, no-key, no-decrypt, no-sign, no-upload renderer driven by the Bun
 * runner (S2S_RUNNER_URL). The website-starter dev kit (Slice 2) POSTs
 * `{ cid, inputs }` to the runner with ALL render inputs injected as
 * `inputs` — local template/partial/helper sources + plaintext body + config —
 * and gets an HTML string back. No chain, no Lit.Actions.* call, no keys.
 *
 * It shares the SAME pure renderer core as the production render action:
 * `buildTemplateData` (non-decrypt init path), `filterCollection`, and
 * `renderHTMLFromSource` — one source, two input-provisioning modes, so
 * preview ≈ production by construction.
 */
import { validateDevRenderInput } from './schema';
import { buildTemplateData, filterCollection } from '../render/data.ctrlr';
import { renderHTMLFromSource } from '../renderer/html.ctrlr';

export async function main(input: unknown) {
  const trace: any[] = [];
  const t0 = Date.now();

  try {
    // Validated dev-shaped input (mirrors validateSingleInput, but no
    // signature/publication/endpoints required).
    const parsed = validateDevRenderInput(input);
    trace.push({ action: 'validate', ms: Date.now() - t0 });

    const {
      config,
      templateConfig,
      templateSource,
      partialsSource,
      body,
      collections,
      allDeals,
      protocolInfo,
    } = parsed;

    // 1. Build templateData via the SHARED non-decrypt init path.
    //    body is plaintext (encryption: false) — no decrypt, no chain.
    const templateData = buildTemplateData(body as any, templateConfig as any, protocolInfo);

    // 2. Collections: use injected pre-built collections, or run the shared
    //    pure collection filter over injected allDeals[].
    let resolvedCollections: Record<string, any[]> = collections || {};
    if (allDeals && Array.isArray(allDeals) && (templateConfig.collections || []).length > 0) {
      resolvedCollections = {};
      for (const collection of templateConfig.collections || []) {
        resolvedCollections[collection.slug] = filterCollection(allDeals, collection);
      }
    }
    templateData.collections = resolvedCollections;
    trace.push({
      action: 'templateData',
      collections: Object.keys(resolvedCollections),
      ms: Date.now() - t0,
    });

    // 3. Render from injected template/partial sources with BUILT-IN helpers
    //    only. The Track-2 runtime publication-helper injection path is DEAD
    //    (see brain/specs/RFC-content-transforms.md) — no source→function
    //    compilation happens at render time, in dev or production. Any
    //    `helpersSource` an old dev kit still sends is ignored (built-ins only,
    //    which now includes the `prevNext` ring helper).
    const html = renderHTMLFromSource(templateSource, partialsSource || {}, templateData);
    trace.push({ action: 'render', htmlBytes: html.length, ms: Date.now() - t0 });

    if (!html) {
      return {
        ok: false,
        action: 'render-dev',
        error: 'render produced empty html',
        trace,
      };
    }

    // ActionResult-shaped output — no CIDs, no signature, no upload.
    return {
      ok: true,
      action: 'render-dev',
      html,
      trace,
    };
  } catch (e) {
    return {
      ok: false,
      action: 'render-dev',
      error: typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      trace,
    };
  }
}
