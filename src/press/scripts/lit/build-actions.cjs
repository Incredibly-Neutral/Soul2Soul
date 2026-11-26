const esbuild = require('esbuild');
const { transform } = require('esbuild');
const fs = require('fs');
const path = require('path');

// esbuild writes each module's cwd-relative path into the bundle as its module
// key, so where the tree sits decides the bytes — and therefore the action CID.
// Anchor to src/ so shared code is always labelled `shared/dist/...` and moving
// a top-level folder cannot change a bundle.
const SRC = path.resolve(__dirname, '../../..');
process.chdir(SRC);

const entries = [
  { in: './press/actions/src/prep/main.ts', out: './press/actions/dist/prep/main.js' },
  { in: './press/actions/src/render/main.ts', out: './press/actions/dist/render/main.js' },
  { in: './press/actions/src/update/main.ts', out: './press/actions/dist/update/main.js' },
  {
    in: './press/actions/src/maintain-cache/main.ts',
    out: './press/actions/dist/maintain-cache/main.js',
  },
  {
    in: './press/actions/src/repoint-archive/main.ts',
    out: './press/actions/dist/repoint-archive/main.js',
  },
  {
    in: './press/actions/src/render-dev/main.ts',
    out: './press/actions/dist/render-dev/main.js',
  },
  { in: './press/actions/src/decrypt/main.ts', out: './press/actions/dist/decrypt/main.js' },
  { in: './press/actions/src/encrypt/main.ts', out: './press/actions/dist/encrypt/main.js' },
];

Promise.all(
  entries.map(({ in: entryPoint, out: outFile }) =>
    esbuild
      .build({
        absWorkingDir: SRC,
        entryPoints: [entryPoint],
        bundle: true,
        outfile: outFile,
        format: 'iife',
        globalName: '__LitAction',
        platform: 'browser',
        target: 'es2020',
        minify: false,
        treeShaking: false, // ← keep everything
        mainFields: ['browser', 'module', 'main'],
        external: ['ethers', '@lit-protocol/*', 'crypto', 'stream', 'buffer', 'util'],
        define: {
          'process.env.NODE_ENV': '"production"',
          global: 'globalThis',
        },
      })
      .then(async () => {
        let code = fs.readFileSync(outFile, 'utf8');

        // Same reason as the chdir above: esbuild writes each module's key into
        // the output, so a bundled dependency is labelled `../node_modules/...`
        // from src/ but `node_modules/...` from the repo root. Drop the relative
        // prefix so the label doesn't encode the tree's depth.
        code = code.replace(/"((?:\.\.\/)+)node_modules\//g, '"node_modules/');

        code = code.replace(/"use strict";\s*/g, '');

        const iife = 'var __LitAction = (() => {';
        const start = code.indexOf(iife) + iife.length;
        const end = code.lastIndexOf('})();');
        code = code.substring(start, end);
        code = code.replace(/\s*return __toCommonJS\(main_exports\);\s*$/, '');

        // Comment removal is the parser's job. The hand-rolled //-regexes this
        // replaces cut the line `// render/main.ts, where the private fields
        // exist.` at the `.ts`, ate the newline and left `, where the private
        // fields exist.` as code, so the render action died on first evaluation
        // with `SyntaxError: Unexpected token ','` at __litEvalCached. A regex
        // cannot tell a comment from `//` inside a string or a regex literal.
        // minifyWhitespace drops every comment and collapses whitespace through
        // esbuild's parser, so it either emits valid code or fails here.
        code = (
          await transform(code, {
            loader: 'js',
            target: 'es2020',
            minifyWhitespace: true,
            minifySyntax: false,
            minifyIdentifiers: false,
            legalComments: 'none',
          })
        ).code;

        // The transform above parsed the input, but the isolate evaluates a
        // bare body: anything a function body rejects (a stray top-level
        // `import`) is still a broken deploy. Compile once, here, where the CID
        // is made.
        try {
          new Function(code);
        } catch (err) {
          throw new Error(
            `${outFile} is not valid JavaScript after comment stripping: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Hard gate: an action isolate has NO `require`. Every external in this
        // build (ethers, the node builtins, @lit-protocol/*) is marked external
        // because the runtime supplies it another way — ethers as a global — so
        // a real call means some module reachable from a shared action entry
        // (lit-actions, gates, rendering/action-io) statically imported one.
        // Left alone, the bundle dies at load with
        //   Dynamic require of "ethers" is not supported
        // and the node returns a bare `{error}` body with no logs, which is
        // undiagnosable from the caller. Fail here, where the CID is made.
        const dynamicRequire = code.match(/(?:__require|\brequire)\s*\(\s*["'][^"']+["']/g);
        if (dynamicRequire) {
          throw new Error(
            `${outFile} calls require() at runtime (${[...new Set(dynamicRequire)].join(', ')}) ` +
              '— a Lit Action isolate has none. Do not import an action-build external ' +
              '(ethers, node builtins) from anything reachable by shared ' +
              'lit-actions / gates / rendering-action-io; see shared src/action-entries.test.ts',
          );
        }

        fs.writeFileSync(outFile, code.trim());
        console.log(`Build complete: ${outFile}`);
      }),
  ),
).catch((err) => {
  // Print, never swallow: an empty exit-1 is unreadable on CI.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
