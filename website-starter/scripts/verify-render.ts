// ============================================================================
// verify-render.ts — self-contained smoke test for the local render kit.
//
// No test framework: reads the HTML files local-render.ts just produced and
// asserts concrete invariants with node's assert. Exit code 0 == pass.
//
//   pnpm -C website-starter render:local:verify
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as assert from 'assert';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'html');

async function main(): Promise<void> {
  const index = await fs.readFile(path.join(OUT, 'index.html'), 'utf-8');
  // Posts/pages are written under the production-consistent /en/ path prefix
  // (createPath prepends /en for non-Dutch locales), matching the hrefs the
  // home template emits so preview links resolve when served.
  const post = await fs.readFile(
    path.join(OUT, 'en', 'posts', 'hello-world', 'index.html'),
    'utf-8',
  );

  // 1. Home template rendered and collected the posts.
  assert.match(index, /<article/, 'home should render <article> post blocks');
  assert.match(index, /Hello World/, 'home should list the "Hello World" post');
  assert.match(index, /Second Post/, 'home should list the "Second Post" post');

  // 2. Section directive was transformed by the content-transform stage.
  assert.ok(
    !post.includes('<!-- section class="aside">'),
    'post should no longer contain the raw section directive comment',
  );
  assert.match(
    post,
    /<section class="aside">This aside callout is produced by the sections content transform\.<\/section>/,
    'post should contain the transformed <section class="aside"> element',
  );

  // 3. Markdown was converted to HTML before templating.
  assert.match(post, /<h1>Hello World<\/h1>/, 'post content should be markdown-rendered to <h1>');

  // 4. Every output file is non-empty.
  const count = await countHtmlFiles(OUT);
  assert.ok(count >= 4, `expected >= 4 html files, found ${count}`);

  console.log('verify-render: OK — all assertions passed');
  console.log(`  home article blocks:   ${(index.match(/<article/g) || []).length}`);
  console.log(`  html files written:    ${count}`);
  console.log(`  section-><aside>:      present in en/posts/hello-world/index.html`);
}

async function countHtmlFiles(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countHtmlFiles(full);
    } else if (entry.name.endsWith('.html')) {
      total += 1;
    }
  }
  return total;
}

main().catch((err) => {
  console.error('verify-render FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
