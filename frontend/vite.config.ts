import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // must run before @vitejs/plugin-react — generates src/routeTree.gen.ts
    // from the file-based routes in src/routes/.
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Exocortex',
        short_name: 'Exocortex',
        description: "Bradie's exocortex",
        start_url: '/',
        display: 'standalone',
        background_color: '#aba3b2',
        theme_color: '#7c5cbf',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // precache the app shell (JS/CSS/HTML/icons)
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        // Never let the SPA's navigate-fallback hijack a Flask-owned or
        // auth-gated path — these must always hit the network (and Flask),
        // never fall back to the cached app-shell index.html.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/login/,
          /^\/logout/,
          /^\/auth\//,
          // Reverse proxies + Flask-served content (iframe navigations count
          // as navigations too — the SW must never hand these the app shell):
          /^\/terminal\//, // ttyd web terminal
          /^\/files\//, // code-server (note trailing slash — /files itself IS the SPA)
          /^\/receipts\//, // uploaded receipt files
          /^\/archivals\//, // archival photos
        ],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // keep the SW disabled under `vite dev` — proxying + HMR + a service
        // worker fighting over /api responses is not worth the debugging tax.
        enabled: false,
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5000',
      '/login': 'http://127.0.0.1:5000',
      '/logout': 'http://127.0.0.1:5000',
      '/auth': 'http://127.0.0.1:5000',
      '/terminal': 'http://127.0.0.1:5000',
      '/receipts': 'http://127.0.0.1:5000',
      '/archivals': 'http://127.0.0.1:5000',
    },
  },
});
