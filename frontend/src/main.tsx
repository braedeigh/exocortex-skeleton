import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import './index.css';
import { routeTree } from './routeTree.gen';

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
