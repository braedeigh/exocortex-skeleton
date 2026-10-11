import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  // Vite's default cache dir is node_modules/.vite — and an unattended
  // session's worktree (worktrees.py) gets node_modules as a SYMLINK to the
  // main checkout's, so every worktree would share one cache and two builds
  // running at once would corrupt each other's optimized deps. The night crew
  // never hit this because it runs one job at a time; parallel sessions are
  // the entire point here. Project-root-relative, so each worktree gets its
  // own automatically.
  cacheDir: '.vite-cache',
  // Keep function names through minification. api/journey.ts names the React
  // component a tap landed in by reading `type.name` off the fiber, and a
  // minified build would call every component `t`. Costs a few KB of bundle.
  // This is Vite 8 (rolldown), so it's the bundler's output option, not
  // esbuild's — `esbuild.keepNames` only reaches the dep optimizer here.
  build: { rollupOptions: { output: { keepNames: true } } },
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
        description: 'A personal exocortex',
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
        // Pull the web-push 'push' / 'notificationclick' handlers
        // (public/push-sw.js, plain JS) into the generated sw.js via
        // importScripts — keeps them out of the workbox-managed bundle
        // while still running inside the same service worker.
        importScripts: ['push-sw.js'],
        // Navigations are NETWORK-FIRST, never precache-first: Flask injects
        // per-request boot globals (VIEW_MODE / PUBLIC_INTRO_HTML /
        // THEME_OVERRIDES / APP_META) into the shell HTML, and the precached
        // dist/index.html carries none of them. Served to a public visitor it
        // makes the app think it's authed → private queries fire → 401 → the
        // api client hard-redirects to /login, kicking strangers off every
        // page after the SW's first install. This mirrors the old
        // static/sw.js (network-first, offline fallback only): online always
        // gets Flask's injected HTML; offline falls back to the last cached
        // copy of that page. So: no navigateFallback at all — the runtime
        // route below owns navigations.
        navigateFallback: null,
        runtimeCaching: [
          {
            // All top-level navigations EXCEPT Flask-owned/auth/proxied paths
            // (ttyd, code-server, receipts, archival photos — iframe
            // navigations count as navigations too). Keep this function
            // self-contained: workbox serializes it into the generated sw.js.
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' &&
              !/^\/(api\/|login|logout|auth\/|terminal\/|files\/|receipts\/|archivals\/)/.test(
                url.pathname,
              ),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages',
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
