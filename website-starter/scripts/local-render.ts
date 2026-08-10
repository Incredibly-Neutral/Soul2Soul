// ============================================================================
// local-render.ts — templating-only local render kit (RFC B, DECIDED direction)
//
// Renders website-starter's handlebars templates against LOCAL data (fixtures +
// local config from mapping.json) and writes the resulting HTML into html/ so
// `pnpm -C website-starter serve` (http-server html -p 3008) previews them.
//
// No chain, no gateway, no decrypt, no signature. The kit drives the renderer
// LAYER only (handlebars.factory + handlebars-helpers + content-transforms),
// reusing its pure functions by import. The only thing replaced vs. the render
// action is the template/partial SOURCE: local files instead of gateway fetches
// (html.ctrlr.renderHTML fetches templates by CID via dag/get + cat and is not
// usable offline — see RFC B §"The key finding that makes it work").
//
// Pipeline per content body (matches the render action's render-time stage):
//   raw markdown  --marked-->  HTML  --transformContent-->  templateData.content
// Stored content stays raw; the transform is applied at render time.
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { marked } from 'marked';
import {
  cleanTemplateString,
  processTemplate,
} from '@s2s/renderer/handlebars.factory';
import { transformContent } from '@s2s/render/content-transforms';
import type { S2SBodyPlain } from '@s2s/soul2soul-shared';
import { postFixtures, pageFixtures } from '../data/fixtures';

// ---------------------------------------------------------------------------
// Paths — anchored to this file so the script works from any cwd.
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..'); // website-starter/
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const PARTIALS_DIR = path.join(TEMPLATES_DIR, 'partials');
const MAPPING_PATH = path.join(ROOT, 'mapping.json');
const OUT_DIR = path.join(ROOT, 'html');

// ---------------------------------------------------------------------------
// Local config — the same source local-config-builder.ts embeds as
// `config.mapping` (mapping.json), read directly instead of via an IPFS upload.
// ---------------------------------------------------------------------------
interface TemplateConfigEntry {
  reference: string;
  file: string | null;
  path: string | null;
  collections?: Array<{ slug: string }>;
  filters?: any[];
}

interface Mapping {
  templateConfig: TemplateConfigEntry[];
  ripples?: any[];
}

async function loadLocalConfig(): Promise<Mapping> {
  const raw = await fs.readFile(MAPPING_PATH, 'utf-8');
  const mapping = JSON.parse(raw) as Mapping;
  if (!Array.isArray(mapping.templateConfig) || mapping.templateConfig.length === 0) {
    throw new Error(`local-render: mapping.json has no templateConfig entries (${MAPPING_PATH})`);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Template reading (LOCAL files — the replacement for the gateway fetch).
// ---------------------------------------------------------------------------
interface LocalPartial {
  name: string;
  content: string;
}

/** Read every .handlebars file under templates/ and templates/partials/. */
async function readLocalTemplates(): Promise<{
  pages: Map<string, string>; // filename (e.g. "home.handlebars") -> raw content
  partials: LocalPartial[];
}> {
  const pages = new Map<string, string>();
  const partials: LocalPartial[] = [];

  const pageEntries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
  for (const entry of pageEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.handlebars')) continue;
    const content = await fs.readFile(path.join(TEMPLATES_DIR, entry.name), 'utf-8');
    pages.set(entry.name, content);
  }

  if (pages.size === 0) {
    throw new Error(`local-render: no .handlebars templates found in ${TEMPLATES_DIR}`);
  }

  let partialEntries: Dirent[] = [];
  try {
    partialEntries = await fs.readdir(PARTIALS_DIR, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    // No partials dir — fine, just no partials.
  }

  for (const entry of partialEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.handlebars')) continue;
    const content = await fs.readFile(path.join(PARTIALS_DIR, entry.name), 'utf-8');
    const name = entry.name.split('.')[0]; // "background.handlebars" -> "background"
    partials.push({ name, content });
  }

  return { pages, partials };
}

// ---------------------------------------------------------------------------
// Content pipeline — markdown -> HTML -> content-transform stage (render time).
// ---------------------------------------------------------------------------
async function contentPipeline(raw: string | undefined): Promise<string> {
  const html = await marked.parse(raw || '');
  return transformContent(html);
}

// ---------------------------------------------------------------------------
// Render — reuses the renderer layer's pure functions; only the template
// SOURCE is local. Mirrors html.ctrlr.renderHTML's partial-substitution +
// processTemplate + final cleanup, minus the gateway fetches.
// ---------------------------------------------------------------------------
function renderPage(
  templateContent: string,
  partials: LocalPartial[],
  templateData: Record<string, any>,
): string {
  let html = cleanTemplateString(templateContent);

  // Recursively substitute {{> name }} partials (max 10 levels, like
  // processPartials in the renderer).
  let depth = 0;
  let changed = true;
  while (changed && depth < 10) {
    changed = false;
    for (const partial of partials) {
      const regex = new RegExp(`{{\\s*>\\s*${partial.name}\\s*}}`, 'g');
      if (regex.test(html)) {
        html = html.replace(regex, partial.content);
        changed = true;
      }
    }
    html = cleanTemplateString(html);
    depth++;
  }

  // Run the handlebars engine (blocks -> helpers -> variables).
  html = processTemplate(html, templateData);

  // Final cleanup mirroring renderHTML: collapse blank lines, one element per
  // line, and strip anything before the DOCTYPE.
  let cleaned = html
    .replace(/\n{2,}/g, '\n')
    .replace(/>\s+</g, '>\n<')
    .trim();
  const doctypeIndex = cleaned.search(/<!DOCTYPE/i);
  if (doctypeIndex > 0) {
    cleaned = cleaned.substring(doctypeIndex);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// templateData builders — mirror initTemplateData's shape (spread body + path +
// custom + transformed content) with LOCAL data only.
// ---------------------------------------------------------------------------
function languageOf(body: S2SBodyPlain): string {
  return body.locale === 'nl' ? 'nl' : 'en';
}

/** Path for a body, mirroring data.ctrlr.createPath (local re-implementation). */
function createPath(body: S2SBodyPlain, templateConfig: TemplateConfigEntry): string {
  if (templateConfig.path == null) return '/';
  let p = body.locale === 'nl' || body.locale === undefined
    ? templateConfig.path
    : `/en${templateConfig.path}`;
  if (!body.encryption && body.slug && p.includes('{slug}')) {
    p = p.replace('{slug}', body.slug);
  }
  return p;
}

/** Map a render-path (e.g. "/en/posts/hello-world/") to a file under OUT_DIR. */
function outFileFor(pagePath: string): string {
  const rel = pagePath.replace(/^\/+/, ''); // strip leading slashes
  if (!rel) return 'index.html';
  return path.join(rel, 'index.html');
}

interface PageSpec {
  outFile: string; // path relative to OUT_DIR
  templateFile: string;
  templateData: Record<string, any>;
}

async function buildPageSpecs(
  mapping: Mapping,
  pages: Map<string, string>,
): Promise<PageSpec[]> {
  const configFor = (reference: string): TemplateConfigEntry => {
    const entry = mapping.templateConfig.find((t) => t.reference === reference);
    if (!entry) throw new Error(`local-render: no templateConfig for reference "${reference}" in mapping.json`);
    return entry;
  };

  const specs: PageSpec[] = [];

  // --- home ----------------------------------------------------------------
  const homeConfig = configFor('home');
  const homeTemplate = pages.get(homeConfig.file || 'home.handlebars');
  if (!homeTemplate) throw new Error(`local-render: missing template ${homeConfig.file} for home`);
  const homePosts = await Promise.all(
    postFixtures.map(async (post) => ({
      ...post,
      path: createPath(post, configFor('post')),
      content: await contentPipeline(post.content),
    })),
  );
  specs.push({
    outFile: 'index.html',
    templateFile: homeConfig.file || 'home.handlebars',
    templateData: {
      language: 'en',
      gateway: 'local',
      custom: {},
      path: '/',
      collections: { posts: homePosts },
      revoked: false,
    },
  });

  // --- posts ---------------------------------------------------------------
  const postConfig = configFor('post');
  const postTemplate = pages.get(postConfig.file || 'post.handlebars');
  if (!postTemplate) throw new Error(`local-render: missing template ${postConfig.file} for post`);
  for (const post of postFixtures) {
    const postPath = createPath(post, postConfig);
    specs.push({
      outFile: outFileFor(postPath),
      templateFile: postConfig.file || 'post.handlebars',
      templateData: {
        ...post,
        gateway: 'local',
        path: postPath,
        custom: post.custom || {},
        content: await contentPipeline(post.content),
        language: languageOf(post),
        collections: {},
        revoked: false,
      },
    });
  }

  // --- pages ---------------------------------------------------------------
  const pageConfig = configFor('page');
  const pageTemplate = pages.get(pageConfig.file || 'page.handlebars');
  if (!pageTemplate) throw new Error(`local-render: missing template ${pageConfig.file} for page`);
  for (const page of pageFixtures) {
    const pagePath = createPath(page, pageConfig);
    specs.push({
      outFile: outFileFor(pagePath),
      templateFile: pageConfig.file || 'page.handlebars',
      templateData: {
        ...page,
        gateway: 'local',
        path: pagePath,
        custom: page.custom || {},
        content: await contentPipeline(page.content),
        language: languageOf(page),
        collections: {},
        revoked: false,
      },
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const mapping = await loadLocalConfig();
  const { pages, partials } = await readLocalTemplates();
  const specs = await buildPageSpecs(mapping, pages);

  // Fail loudly on a spec whose template file is missing.
  for (const spec of specs) {
    if (!pages.has(spec.templateFile)) {
      throw new Error(`local-render: template file "${spec.templateFile}" not found in ${TEMPLATES_DIR}`);
    }
  }

  // Idempotent: recreate the output dir each run.
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const written: string[] = [];
  for (const spec of specs) {
    const html = renderPage(pages.get(spec.templateFile)!, partials, spec.templateData);
    if (!html) {
      throw new Error(`local-render: rendered empty HTML for ${spec.templateFile}`);
    }
    const outPath = path.join(OUT_DIR, spec.outFile);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html, 'utf-8');
    written.push(outPath);
  }

  console.log(`local-render: wrote ${written.length} page(s) to ${OUT_DIR}`);
  for (const file of written) {
    console.log(`  -> ${path.relative(ROOT, file)}`);
  }
}

main().catch((err) => {
  console.error('local-render failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
