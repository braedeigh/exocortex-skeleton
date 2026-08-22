import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import './index.css';
import { routeTree } from './routeTree.gen';
import { installUsageBeacon } from './api/usageBeacon';
import { installUsageTracker } from './api/usageTracker';
import { installUsageHeat } from './ui/usageHeat';
import { installEffects } from './ui/effects';
import { installPresence } from './push/presence';
import { initTheme } from './theme';

// Boot the theming engine (src/theme — the port of static/js/sky-theme.js)
// before first paint of the app: reads window.THEME_OVERRIDES (injected by
// routes/spa.py at the end of <head>, so it's already set by the time this
// module runs), applies the palette as CSS custom properties on
// documentElement, re-computes every 2 minutes, and handles cross-frame
// 'theme-changed' messages.
initTheme();

// The "reduced effects" switch (Settings toggle) — stamps data-effects on
// <html>, which turns theme.css's --frost-* tokens off. Runs beside initTheme
// so the first paint is already correct: the backdrop blur is the app's most
// expensive paint, and a reduced session shouldn't pay for a frame of it.
installEffects();

// split.html (the old shell) registered a service worker at /static/sw.js,
// scope /static/. The SPA's own SW (vite-plugin-pwa) registers at / scope —
// leaving the old one around would fight it, so unregister it on boot.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) {
      if (reg.active?.scriptURL.endsWith('/static/sw.js')) {
        reg.unregister();
      }
    }
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const router = createRouter({ routeTree });

// Count tab visits (fire-and-forget POST /api/usage/tab on each navigation).
installUsageBeacon(router);

// Dwell clock + [data-track] click counter, batched to POST /api/usage/batch.
installUsageTracker(router);

// The "usage heat view" overlay (Settings toggle) — tints tracked controls
// on /journal and /todos by how often they're actually used.
installUsageHeat(router);

// Web push visibility heartbeat — tells the server whether this device has
// the app open and visible, so it can skip a redundant push. No-ops unless
// push is already enabled on this device (src/push/presence.ts).
installPresence();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
