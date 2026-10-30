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

        // const result = await transform(code, {
        //   loader: "js",
        //   minifyWhitespace: false,
        //   minifySyntax: false,
        //   minifyIdentifiers: false,
        // });
        // code = result.code;

        code = code.replace(/"use strict";\s*/g, '');
        code = code.replace(/\/\/ [^\n]+\.ts\n?/g, ''); // strip esbuild source comments with newline
        code = code.replace(/(?<!['":`])\/\/[^\n]*/g, ''); // strip all remaining single-line comments

        // Same reason as the chdir above: esbuild writes each module's key into
        // the output, so a bundled dependency is labelled `../node_modules/...`
        // from src/ but `node_modules/...` from the repo root. Drop the relative
        // prefix so the label doesn't encode the tree's depth.
        code = code.replace(/"((?:\.\.\/)+)node_modules\//g, '"node_modules/');

        const iife = 'var __LitAction = (() => {';
        const start = code.indexOf(iife) + iife.length;
        const end = code.lastIndexOf('})();');
        code = code.substring(start, end);
        code = code.replace(/\s*return __toCommonJS\(main_exports\);\s*$/, '');

        fs.writeFileSync(outFile, code.trim());
        console.log(`Build complete: ${outFile}`);
      }),
  ),
).catch(() => process.exit(1));
