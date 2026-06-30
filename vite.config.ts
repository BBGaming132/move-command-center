import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Move Command Center',
        short_name: 'Move Center',
        description: 'Offline-first moving inventory, room routing, and receiving tracker.',
        theme_color: '#f4f7fb',
        background_color: '#f4f7fb',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        navigateFallback: 'index.html'
      }
    })
  ],
  build: {
    sourcemap: false,
    target: 'es2022'
  }
});
