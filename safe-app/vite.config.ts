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
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]'
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
    // Point TS source directly — avoids CJS dist entirely
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/components': resolve(__dirname, 'src/components'),
      '@/types': resolve(__dirname, 'src/types'),
      '@/utils': resolve(__dirname, 'src/utils'),
      '@s2s/soul2soul-shared': resolve(__dirname, '../shared/src'),
      '@s2s/soul2soul-shared/protocol': resolve(__dirname, '../shared/src/protocol'),
      '@s2s/soul2soul-shared/publication': resolve(__dirname, '../shared/src/publication'),
      '@s2s/soul2soul-shared/lit': resolve(__dirname, '../shared/src/lit'),
      '@s2s/soul2soul-shared/lit-actions': resolve(__dirname, '../shared/src/lit-actions'),
    }
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
