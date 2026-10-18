import * as esbuild from 'esbuild';

const production = process.argv[2] === 'production';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/cli.cjs',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  treeShaking: true,
  conditions: ['import'],
};

if (production) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
