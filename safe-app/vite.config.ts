import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  // Base path for deployment
  base: './',
  
  // Build configuration
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    
    // Rollup options
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    },
    copyPublicDir: true,
    
    // Generate source maps for debugging
    sourcemap: true,
    
    // Don't minify for easier debugging (optional)
    minify: 'terser',
    
    // Target modern browsers
    target: 'es2020',
  },
  publicDir: 'public',

  // Development server
  server: {
    port: 3000,
    open: true,
    cors: true,
    
    // Headers for Safe App development
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': 'frame-ancestors *',
      'Cross-Origin-Embedder-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin'
    },
    
    // Add this - Allow reading linked packages
    fs: {
      strict: false
    }
  },

  // Preview server (for testing built app)
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

  // Path resolution
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/components': resolve(__dirname, 'src/components'),
      '@/types': resolve(__dirname, 'src/types'),
      '@/utils': resolve(__dirname, 'src/utils')
    }
  },

  // Define global constants
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString())
  },

  // CSS configuration
  css: {
    devSourcemap: true
  },

  // Optimize deps
  optimizeDeps: {
    include: ['ethers'],
  },
})