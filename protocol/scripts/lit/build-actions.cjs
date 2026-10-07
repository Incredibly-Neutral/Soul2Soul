const esbuild = require('esbuild');
const { transform } = require('esbuild');
const fs = require('fs');

const entries = [
  { in: './protocol/actions/src/prep/main.ts', out: './protocol/actions/dist/prep/main.js' },
  { in: './protocol/actions/src/render/main.ts', out: './protocol/actions/dist/render/main.js' },
  { in: './protocol/actions/src/update/main.ts', out: './protocol/actions/dist/update/main.js' },
  {
    in: './protocol/actions/src/maintain-cache/main.ts',
    out: './protocol/actions/dist/maintain-cache/main.js',
  },
  {
    in: './protocol/actions/src/repoint-archive/main.ts',
    out: './protocol/actions/dist/repoint-archive/main.js',
  },
  {
    in: './protocol/actions/src/render-dev/main.ts',
    out: './protocol/actions/dist/render-dev/main.js',
  },
];

Promise.all(
  entries.map(({ in: entryPoint, out: outFile }) =>
    esbuild
      .build({
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
