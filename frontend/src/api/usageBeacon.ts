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
export const DEFAULT_TAB = 'todos';

/** First path segment, lowercased — the app's "tab" identity ("/" counts as
 * the default tab it redirects to). Shared with usageTracker.ts. */
export function tabFromPathname(pathname: string): string {
  return pathname.split('/').find(Boolean)?.toLowerCase() ?? DEFAULT_TAB;
}

/** Conversation ids as the observatory mints them: `<date>.<HHMMSS>` with an
 * optional `-<n>` suffix. Kept in step with `_CONV_RE` in routes/usage.py —
 * the server rejects anything else with a 400, so a mismatch here would show
 * up as silently dropped telemetry. */
const CONV_ID_RE = /^[0-9A-Za-z._-]{1,64}$/;

/**
 * The conversation a location is looking at, or null. Only /observatory
 * carries one, as `?conv=<id>`.
 *
 * Two values are deliberately NOT conversations. `?conv=latest` is a sentinel
 * the route swaps for a real id on mount — counting it would invent a
 * conversation that never existed. And a brand-new chat has no `conv` at all
 * until its first send puts one in the url, so its opening seconds belong to
 * no id; they stay in the tab total and out of the per-conversation split
 * rather than being guessed onto the previous conversation.
 *
 * Shared with usageTracker.ts; `search` is whatever the router parsed, so it
 * is treated as unknown and shape-checked here.
 */
export function convFromLocation(pathname: string, search: unknown): string | null {
  if (tabFromPathname(pathname) !== 'observatory') return null;
  if (typeof search !== 'object' || search === null) return null;
  const raw = (search as Record<string, unknown>).conv;
  if (typeof raw !== 'string' || raw === 'latest') return null;
  return CONV_ID_RE.test(raw) ? raw : null;
}

/**
 * Valid tab names, derived from the route tree itself (first path segment
 * of every registered route) rather than a hand-maintained list — so new
 * route files are counted automatically and junk paths (/login, 404s,
 * typo'd deep links) are not. Shared with usageTracker.ts.
 */
export function deriveValidTabs(router: AnyRouter): Set<string> {
  const validTabs = new Set<string>();
  for (const path of Object.keys(router.routesByPath as Record<string, unknown>)) {
    const seg = path.split('/').find(Boolean);
    if (seg && !seg.startsWith('$')) {
      validTabs.add(seg.toLowerCase());
    }
  }
  return validTabs;
}

/**
 * Subscribe to router navigation and beacon each distinct tab visit.
 * Call once in main.tsx, right after createRouter.
 */
export function installUsageBeacon(router: AnyRouter): void {
  const validTabs = deriveValidTabs(router);

  let lastSent: string | null = null;

  const send = (pathname: string) => {
    const tab = tabFromPathname(pathname);
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
