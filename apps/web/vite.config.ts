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
        name: 'Assistant',
        short_name: 'Assistant',
        start_url: '/',
        display: 'standalone',
        // Light --color-bg from src/tokens.css.
        theme_color: '#ffffff',
        background_color: '#ffffff',
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
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/healthz/] },
    }),
  ],
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
  test: { environment: 'node' },
});
