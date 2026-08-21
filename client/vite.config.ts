import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(clientDir, '..');
const sharedSrc = path.resolve(repoRoot, 'shared/src');
const clientSrc = path.resolve(clientDir, 'src');

/** Dev-server proxy: the game server owns ws://localhost:8080/ws. */
const wsProxy = {
  '/ws': {
    target: 'ws://localhost:8080',
    ws: true,
    changeOrigin: false,
    rewriteWsOrigin: true,
  },
};

export default defineConfig({
  root: clientDir,
  base: './',
  publicDir: path.resolve(clientDir, 'public'),
  cacheDir: path.resolve(repoRoot, 'node_modules/.vite'),

  resolve: {
    alias: [
      { find: /^@shared$/, replacement: path.join(sharedSrc, 'index.ts') },
      { find: /^@shared\//, replacement: sharedSrc + '/' },
      { find: /^@\//, replacement: clientSrc + '/' },
    ],
  },

  build: {
    target: 'esnext',
    outDir: path.resolve(repoRoot, 'dist'),
    emptyOutDir: true,
    assetsDir: 'a',
    assetsInlineLimit: 4096,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // three is big and never changes between our builds: give it its own
        // long-lived chunk so a game-code deploy does not re-download it.
        manualChunks(id: string) {
          // three/examples is NOT three. `characters/loader.ts` dynamic-imports
          // GLTFLoader precisely so the menu never waits for a 100 KB glTF
          // parser it may never need, and forcing it into the eager `three`
          // chunk quietly undid that: measured, it put 29.5 KB gzipped of
          // parser on the critical path. Leaving it unassigned lets rollup keep
          // the dynamic import in its own lazily-fetched chunk.
          if (id.includes('/node_modules/three/examples/')) return undefined;
          if (id.includes('/node_modules/three/')) return 'three';
          return undefined;
        },
        entryFileNames: 'a/[name]-[hash].js',
        chunkFileNames: 'a/[name]-[hash].js',
        assetFileNames: 'a/[name]-[hash][extname]',
      },
    },
  },

  // Chunk meshing runs in a module worker; no IIFE fallback, no legacy shims.
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'a/[name]-[hash].js',
        chunkFileNames: 'a/[name]-[hash].js',
      },
    },
  },

  esbuild: {
    legalComments: 'none',
    target: 'esnext',
  },

  optimizeDeps: {
    include: ['three'],
    esbuildOptions: { target: 'esnext' },
  },

  server: {
    port: 5173,
    strictPort: true,
    host: true,
    fs: { allow: [repoRoot] },
    proxy: wsProxy,
  },

  preview: {
    port: 4173,
    strictPort: true,
    proxy: wsProxy,
  },
});
