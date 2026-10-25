import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const api = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Avustaja',
        short_name: 'Avustaja',
        lang: 'fi',
        start_url: '/',
        display: 'standalone',
        // Light --background from src/tokens.css.
        theme_color: '#faf9f5',
        background_color: '#faf9f5',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/healthz/],
        // Push and notification-click handlers (public/push-sw.js).
        importScripts: ['push-sw.js'],
        // The app's own chunks; Mermaid's lazy chunks (`assets/lazy/`) and the artifact runtime
        // are fetched (and cached) on first use instead of adding ~5 MB to the install.
        // Fonts: only the latin `wght` files (Finnish ä, ö, å are in it); other subsets load on use.
        globPatterns: [
          'index.html',
          'assets/*.{js,css}',
          'assets/*-latin-wght-*.woff2',
          '*.{png,webmanifest}',
        ],
        globIgnores: ['assets/lazy/**', 'assets/artifact-runtime-*.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: { cacheName: 'assets', expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  // The shadcn/ui import alias `@/` from tsconfig.json `paths`.
  resolve: { tsconfigPaths: true },
  build: {
    rolldownOptions: {
      output: {
        // Chunks without app code are the lazily loaded libraries (Mermaid and its renderers).
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes('/apps/web/src/'))
            ? 'assets/[name]-[hash].js'
            : 'assets/lazy/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
  test: { environment: 'node' },
});
