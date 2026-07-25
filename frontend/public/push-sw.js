/**
 * push-sw.js — web-push handlers, imported into the generated workbox
 * service worker via `importScripts` (see vite.config.ts's VitePWA workbox
 * block). Plain JS: runs inside the SW's importScripts context, no bundling,
 * no imports of app code.
 *
 * Payloads (see pushClient.ts / routes/push.py) are JSON:
 *   {"title": string, "body": string, "url": string}
 */

self.addEventListener('push', (event) => {
  let payload = { title: 'Exocortex', body: '' };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch {
    // Non-JSON or missing payload — fall back to the generic notification
    // above rather than dropping the push silently.
  }

  const title = payload.title || 'Exocortex';
  const url = payload.url || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Reuse an already-open tab instead of stacking new windows —
        // navigate it to the target url if it supports client-side nav.
        if ('focus' in client) {
          if (url && 'navigate' in client) {
            client.navigate(url).catch(() => {});
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
      return undefined;
    }),
  );
});
