/**
 * render-dev — standalone local render kit (RFC B, Option C).
 *
 * Renders this website-starter's templates/helpers/scripts LOCALLY by driving
 * the protocol "render-dev" action through the Bun runner:
 *
 *   POST { cid: <dev-action-cid>, inputs } -> S2S_RUNNER_URL
 *   response = { success, response } where response is the action's
 *   ActionResult: { ok:true, action:'render-dev', html, trace } on success, or
 *   { ok:false, error, trace } on failure.
 *
 * The kit gathers ALL render materials locally — template source, partial
 * sources, plaintext fixture bodies, and the publication helper source — and
 * writes the returned HTML to html/<name>.html for the existing `pnpm serve`
 * preview (http-server on :3008).
 *
 * STANDALONE CONSTRAINT: a publication dev has ONLY this component locally
 * (not `shared`, not `protocol`). This script therefore imports NOTHING from
 * `@s2s/*` -- only Node builtins (fs/path/process/url), global `fetch`, and
 * `dotenv`. The render logic itself lives in the deployed render-dev action
 * (shared with production), so preview ≈ production by construction.
 *
 * Iteration loop: edit a template, a fixture body, or fixtures/helpers.source,
 * then re-run `pnpm render:dev` and refresh http://localhost:3008.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Resolve the package root from this script's own location so the kit works
// regardless of the cwd it is invoked from. This package is CommonJS (no
// "type": "module"), so __dirname is available under tsx.
const PKG_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Wiring (the only two config strings the standalone kit needs)
// ---------------------------------------------------------------------------
const RUNNER_URL = process.env.S2S_RUNNER_URL || 'https://run.transport-union.dev/run';
const DEV_ACTION_CID =
  process.env.S2S_DEV_ACTION_CID || 'QmbMbtySmJbd9a44niJpQN18U7tPdDzpLyEWpMinfdMGEG';

// ---------------------------------------------------------------------------
// Types — mirrors the render-dev action input contract (protocol/actions/src/
// render-dev/schema.ts). The kit builds inputs to match it exactly.
// ---------------------------------------------------------------------------
interface DevCollectionSpec {
  slug: string;
  filters?: unknown[];
}

interface DevTemplateConfig {
  reference?: string;
  file: string;
  path?: string | null;
  collections?: DevCollectionSpec[];
  filters?: unknown[];
}

interface DevBody {
  id?: string;
  author?: string;
  locale?: string;
  parent?: string;
  position?: string;
  postType?: string;
  creationDate?: string;
  modifiedDate?: string;
  tags?: string[];
  attributes?: unknown;
  publication?: string;
  base?: string;
  encryption: false; // REQUIRED literal — the dev action has no decrypt path
  content: string;
  title?: string;
  slug?: string;
  custom?: unknown;
}

interface DevRenderInput {
  // config/protocolInfo are genuinely optional — omitted here (the action
  // tolerates absence).
  templateConfig: DevTemplateConfig;
  templateSource: string;
  partialsSource: Record<string, string>;
  body: DevBody;
  collections?: Record<string, unknown[]>;
  allDeals?: unknown[];
  helpersSource?: string;
}

interface RenderSpec {
  /** Output file stem -> html/<name>.html */
  name: string;
  /** Site template: read templates/<templateFile>.handlebars */
  templateFile?: string;
  /** Demo: literal template source (bypasses the templates/ dir) */
  inlineTemplate?: string;
  body: DevBody;
  templateConfig: DevTemplateConfig;
  collections?: Record<string, unknown[]>;
  allDeals?: unknown[];
}

interface ActionResult {
  ok: boolean;
  action: string;
  html?: string;
  error?: string;
  trace?: unknown[];
}

// ---------------------------------------------------------------------------
// Local material gathering (all standalone — no @s2s/* imports)
// ---------------------------------------------------------------------------
function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Read every templates/partials/*.handlebars keyed by filename w/o extension. */
function gatherPartials(): Record<string, string> {
  const dir = path.join(PKG_ROOT, 'templates', 'partials');
  const out: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.handlebars')) continue;
    const name = file.replace(/\.handlebars$/, '');
    out[name] = readFileSync(path.join(dir, file), 'utf8');
  }
  return out;
}

/** Read the publication helper source verbatim (a JS expression string). */
function readHelpersSource(): string {
  return readFileSync(path.join(PKG_ROOT, 'fixtures', 'helpers.source'), 'utf8');
}

/** Build the exact `inputs` object the render-dev action expects. */
function buildInputs(spec: RenderSpec): DevRenderInput {
  const templateSource = spec.inlineTemplate
    ? spec.inlineTemplate
    : readFileSync(path.join(PKG_ROOT, 'templates', `${spec.templateFile}.handlebars`), 'utf8');

  const inputs: DevRenderInput = {
    templateConfig: spec.templateConfig,
    templateSource,
    partialsSource: gatherPartials(),
    body: spec.body,
    helpersSource: readHelpersSource(),
  };
  if (spec.collections) inputs.collections = spec.collections;
  if (spec.allDeals) inputs.allDeals = spec.allDeals;
  return inputs;
}

// ---------------------------------------------------------------------------
// Runner call
// ---------------------------------------------------------------------------
async function runAction(inputs: DevRenderInput): Promise<ActionResult> {
  const res = await fetch(RUNNER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cid: DEV_ACTION_CID, inputs }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`runner HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const payload = (await res.json()) as { success: boolean; response: ActionResult };
  if (!payload.success) {
    throw new Error(`runner success=false: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload.response;
}

// ---------------------------------------------------------------------------
// Fixture-driven render specs
// ---------------------------------------------------------------------------
function loadSpecs(): RenderSpec[] {
  const body = (name: string): DevBody =>
    readJson<DevBody>(path.join(PKG_ROOT, 'fixtures', 'bodies', `${name}.json`));
  const allDeals = readJson<unknown[]>(path.join(PKG_ROOT, 'fixtures', 'all-deals.json'));
  const demo = readJson<{ template: string; body: DevBody }>(
    path.join(PKG_ROOT, 'fixtures', 'demo.json'),
  );

  return [
    {
      // Home iterates collections.posts — exercise the SHARED pure collection
      // filter by injecting allDeals[] + templateConfig.collections.
      name: 'home',
      templateFile: 'home',
      body: body('home'),
      templateConfig: {
        reference: 'home',
        file: 'home',
        path: '/',
        collections: [{ slug: 'posts', filters: [{ featured: true }] }],
      },
      allDeals,
    },
    {
      name: 'page',
      templateFile: 'page',
      body: body('page'),
      templateConfig: { reference: 'page', file: 'page', path: '/{slug}' },
    },
    {
      name: 'post',
      templateFile: 'post',
      body: body('post'),
      templateConfig: { reference: 'post', file: 'post', path: '/posts/{slug}' },
    },
    {
      // Diagnostic page proving the sections content transform + injected
      // helpers end-to-end on a raw {{{content}}} sink (no extract_images
      // mangling), so the assertions are crisp.
      name: 'demo',
      inlineTemplate: demo.template,
      body: demo.body,
      templateConfig: { reference: 'post', file: 'post', path: '/demo' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const specs = loadSpecs();
  const htmlDir = path.join(PKG_ROOT, 'html');
  mkdirSync(htmlDir, { recursive: true });

  console.log(`render-dev: runner=${RUNNER_URL}`);
  console.log(`render-dev: cid=${DEV_ACTION_CID}`);
  console.log(`render-dev: ${specs.length} render(s) — ${specs.map((s) => s.name).join(', ')}\n`);

  let failures = 0;
  for (const spec of specs) {
    process.stdout.write(`  render-dev: ${spec.name} -> html/${spec.name}.html ... `);
    try {
      const inputs = buildInputs(spec);
      const result = await runAction(inputs);

      if (!result.ok) {
        failures += 1;
        console.error('FAIL (action ok=false)');
        console.error(`    error: ${result.error}`);
        console.error(`    trace: ${JSON.stringify(result.trace, null, 2)}`);
        continue;
      }

      const outPath = path.join(htmlDir, `${spec.name}.html`);
      writeFileSync(outPath, result.html ?? '', 'utf8');
      console.log(`ok (${(result.html ?? '').length} bytes)`);
    } catch (err) {
      failures += 1;
      console.error('FAIL (exception)');
      console.error(`    ${(err as Error).message}`);
    }
  }

  if (failures > 0) {
    console.error(`\nrender-dev: ${failures} render(s) FAILED — see errors above.`);
    process.exit(1);
  }

  console.log('\nrender-dev: all renders OK.');
  console.log('  Preview:  pnpm serve  ->  http://localhost:3008');
  console.log(
    '  Iterate:  edit templates/, fixtures/bodies/*.json or fixtures/helpers.source, then re-run `pnpm render:dev`.',
  );
}

main().catch((err) => {
  console.error('render-dev: fatal:', err);
  process.exit(1);
});
