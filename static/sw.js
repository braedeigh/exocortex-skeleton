// Exocortex service worker.
// Goal: make the app installable + resilient when the phone briefly drops
// signal — WITHOUT ever serving stale content while online. So this is
// strictly network-first: online requests always hit the network (live-reload
// and fresh data keep working), and the cache is only a fallback for offline.
// Bump CACHE_VERSION to retire old caches.

const CACHE_VERSION = "exo-v1";

self.addEventListener("install", (event) => {
  // Activate this SW immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any caches from older versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GETs. Let everything else (POSTs, cross-origin)
  // go straight to the network untouched.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Never cache API or live-data endpoints — they must always be fresh.
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        // Network-first: online always wins, so no staleness.
        const fresh = await fetch(req);
        // Stash a copy for offline fallback (only successful basic responses).
        if (fresh && fresh.ok && fresh.type === "basic") {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        // Offline: serve the last good copy if we have one.
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
