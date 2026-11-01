import * as esbuild from 'esbuild';

const production = process.argv[2] === 'production';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  // The extension host provides this module; it must never be bundled.
  external: ['vscode'],
  sourcemap: production ? true : 'inline',
  logLevel: 'info',
  treeShaking: true,
};

if (production) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
