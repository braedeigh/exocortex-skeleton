/**
 * usageBeacon.ts — fire-and-forget tab-visit counter. On every resolved
 * navigation, POSTs `{tab}` (the first path segment) to /api/usage/tab so the
 * backend can count which tabs actually get used.
 *
 * Deliberately does NOT go through `api.post` (client.ts): that wrapper
 * redirects to /login on 401 and throws on errors, and a telemetry beacon
 * must never do either — in public/unauthenticated views the endpoint 401s
 * harmlessly. Raw fetch with keepalive, all errors swallowed.
 */
import type { AnyRouter } from '@tanstack/react-router';

/** What "/" resolves to: routes/index.tsx redirects to /todos. */
const DEFAULT_TAB = 'todos';

/**
 * Subscribe to router navigation and beacon each distinct tab visit.
 * Call once in main.tsx, right after createRouter.
 */
export function installUsageBeacon(router: AnyRouter): void {
  // Valid tab names, derived from the route tree itself (first path segment
  // of every registered route) rather than a hand-maintained list — so new
  // route files are counted automatically and junk paths (/login, 404s,
  // typo'd deep links) are not.
  const validTabs = new Set<string>();
  for (const path of Object.keys(router.routesByPath as Record<string, unknown>)) {
    const seg = path.split('/').find(Boolean);
    if (seg && !seg.startsWith('$')) {
      validTabs.add(seg.toLowerCase());
    }
  }

  let lastSent: string | null = null;

  const send = (pathname: string) => {
    const seg = pathname.split('/').find(Boolean)?.toLowerCase();
    const tab = seg ?? DEFAULT_TAB;
    // Dedupe sub-route navigation within a tab; skip /login and anything
    // that isn't a real app route.
    if (tab === lastSent || tab === 'login' || !validTabs.has(tab)) {
      return;
    }
    lastSent = tab;
    fetch('/api/usage/tab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab }),
      keepalive: true,
    }).catch(() => {
      // Fire-and-forget: the beacon must never break (or even surface in)
      // navigation. 401s in public view land here too — all fine.
    });
  };

  // Count the tab the app booted on. If "/" immediately redirects to /todos,
  // the onResolved event for /todos dedupes against this same 'todos'.
  send(router.state.location.pathname);

  // onResolved fires once per settled navigation (after any beforeLoad
  // redirects), with the final toLocation — the right moment to attribute
  // a visit, unlike onBeforeNavigate (pre-redirect) or onRendered
  // (can be skipped for already-rendered matches).
  router.subscribe('onResolved', (event) => {
    send(event.toLocation.pathname);
  });
}
