const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
// const Handlebars = require('handlebars');

// Pre-compile the template during build
// const template = `
// <!DOCTYPE html>
// <html lang="{{language}}">
// <head>
//     <meta charset="UTF-8">
//     <title>{{title}}</title>
// </head>
// <body>
//     <article>
//         <h1>{{title}}</h1>
//         {{{content}}}
//     </article>
// </body>
// </html>`;

// const precompiledTemplate = Handlebars.precompile(template);

// Build the action for Lit
esbuild.build({
  entryPoints: ['renderer/src/main.ts'], 
  bundle: true,
  outdir: 'renderer/dist', 
  format: 'iife', 
  platform: 'browser',
  target: 'es2020',
  minify: false,
  mainFields: ['browser', 'module', 'main'],
  external: [
    'ethers'  // Only keep ethers as external since it's provided by Lit
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis'  },
  plugins: [
//     {
//     name: 'handlebars-runtime-only',
//     setup(build) {
//       // Always use the runtime version of Handlebars
//       build.onResolve({ filter: /^handlebars.*$/ }, args => ({
//         path: require.resolve('handlebars/dist/cjs/handlebars.runtime'),
//         namespace: 'file'
//       }));
//     }
//   }
]
}).catch(() => process.exit(1));
