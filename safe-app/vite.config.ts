import { defineConfig } from 'vite'
import { resolve } from 'path'
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.resolve(__dirname, '../.env') });
config(); 

export default defineConfig({
  base: './',

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: {
          entryFileNames: '[name].[hash].js',
          chunkFileNames: '[name].[hash].js',
          assetFileNames: '[name].[hash][extname]'
      }
    },
    copyPublicDir: true,
    sourcemap: true,
    minify: 'terser',
    target: 'es2020',
  },
  publicDir: 'public',

  server: {
    port: 3000,
    open: true,
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': 'frame-ancestors *',
      'Cross-Origin-Embedder-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin'
    },
    fs: { strict: false }
  },

  preview: {
    port: 3000,
    open: true,
    cors: true,
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': 'frame-ancestors *',
      'Cross-Origin-Embedder-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin'
    }
  },

  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src') },
      { find: '@/components', replacement: resolve(__dirname, 'src/components') },
      { find: '@/types', replacement: resolve(__dirname, 'src/types') },
      { find: '@/utils', replacement: resolve(__dirname, 'src/utils') },
      { find: '@s2s/soul2soul-shared', replacement: resolve(__dirname, '../shared/src') },
      { find: '@s2s/soul2soul-shared/protocol', replacement: resolve(__dirname, '../shared/src/protocol') },
      { find: '@s2s/soul2soul-shared/publication', replacement: resolve(__dirname, '../shared/src/publication') },
      { find: '@s2s/soul2soul-shared/lit', replacement: resolve(__dirname, '../shared/src/lit') },
      { find: '@s2s/soul2soul-shared/lit-actions', replacement: resolve(__dirname, '../shared/src/lit-actions') },
      { find: 'filecoin-pin/dist/core/unixfs/browser.js', replacement: resolve(__dirname, '../node_modules/filecoin-pin/dist/core/unixfs/browser.js') },
    ]
  },

  esbuild: {
    target: 'es2020',
    define: { global: 'globalThis' },
  },


  optimizeDeps: {
    include: ['ethers'],
    exclude: ['@s2s/soul2soul-shared'],
  },
})
