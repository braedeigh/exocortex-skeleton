/**
 * usageTracker.ts — the beacon's fatter sibling: accumulates active-dwell
 * seconds per tab and taps on `[data-track]`-tagged controls, and batches
 * them to POST /api/usage/batch. Feeds the usage heat view (src/ui/usageHeat).
 *
 * Like usageBeacon.ts this deliberately bypasses api.post (client.ts): a
 * telemetry flush must never redirect to /login or throw — in public /
 * unauthenticated views the endpoint 401s harmlessly. sendBeacon (fetch
 * keepalive fallback), all errors swallowed.
 *
 * Dwell clock: runs only while the page is visible AND non-idle (idle = no
 * pointerdown/keydown/wheel/touchstart/scroll for 120s — passive listeners,
 * no mousemove). Pauses on visibilitychange-hidden; resumes on visible +
 * the next interaction.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { deriveValidTabs, tabFromPathname } from './usageBeacon';

const IDLE_MS = 120_000;
const FLUSH_INTERVAL_MS = 30_000;
/** Never flush more than once per this window — except on pagehide/hidden. */
const MIN_FLUSH_GAP_MS = 5_000;
/** Server-side control-name contract — anything else is dropped client-side too. */
const TRACK_NAME_RE = /^[a-z0-9:._-]{1,60}$/;
/** usageHeat sets this on <html> while the heat view is showing — taps made
 * while inspecting the heat must not pollute the very counts on display. */
const HEAT_ACTIVE_ATTR = 'data-heat-view';

interface BatchBody {
  time?: Record<string, number>;
  clicks?: Record<string, Record<string, number>>;
}

/**
 * Install the dwell clock + click counter + flush queue. Call once in
 * main.tsx, beside installUsageBeacon.
 */
export function installUsageTracker(router: AnyRouter): void {
  if (typeof window === 'undefined') return;

  const validTabs = deriveValidTabs(router);

  /** null = a page we don't attribute usage to (/login, junk paths). */
  function resolveTab(pathname: string): string | null {
    const tab = tabFromPathname(pathname);
    return tab !== 'login' && validTabs.has(tab) ? tab : null;
  }

  let currentTab = resolveTab(router.state.location.pathname);

  // Accumulators — flushed (and reset) as a whole; dwell keeps sub-second
  // remainders locally so rounding never loses time across flushes.
  const pendingMs: Record<string, number> = {};
  let pendingClicks: Record<string, Record<string, number>> = {};

  let lastInteraction = Date.now();
  /** Timestamp the dwell clock last started/committed at; null = paused. */
  let runningSince: number | null = document.hidden ? null : Date.now();
  let lastFlush = 0;

  /** Fold elapsed running time into the current tab and restart the clock at `upTo`. */
  function commitDwell(upTo = Date.now()): void {
    if (runningSince === null) return;
    const ms = upTo - runningSince;
    if (ms > 0 && currentTab) {
      pendingMs[currentTab] = (pendingMs[currentTab] ?? 0) + ms;
    }
    runningSince = upTo;
  }

  function pauseDwell(upTo = Date.now()): void {
    commitDwell(upTo);
    runningSince = null;
  }

  function flush(force = false): void {
    const now = Date.now();
    if (!force && now - lastFlush < MIN_FLUSH_GAP_MS) return;
    commitDwell(now);

    const time: Record<string, number> = {};
    for (const tab of Object.keys(pendingMs)) {
      const secs = Math.floor(pendingMs[tab] / 1000);
      if (secs > 0) {
        time[tab] = secs;
        pendingMs[tab] -= secs * 1000; // keep the sub-second remainder
      }
    }
    const clicks = pendingClicks;
    pendingClicks = {};

    const body: BatchBody = {};
    if (Object.keys(time).length > 0) body.time = time;
    if (Object.keys(clicks).length > 0) body.clicks = clicks;
    if (!body.time && !body.clicks) return;

    lastFlush = now;
    const json = JSON.stringify(body);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      if (navigator.sendBeacon?.('/api/usage/batch', blob)) return;
    } catch {
      // sendBeacon unavailable/refused — fall through to fetch keepalive
    }
    fetch('/api/usage/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
      credentials: 'include',
    }).catch(() => {
      // Fire-and-forget: 401s in public view, offline, etc — all fine.
    });
  }

  // ---- dwell clock inputs ----

  function onInteraction(): void {
    lastInteraction = Date.now();
    // Resume after idle-pause or visible-after-hidden — but never while hidden.
    if (runningSince === null && !document.hidden) runningSince = lastInteraction;
  }
  const interactionEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
  for (const ev of interactionEvents) {
    window.addEventListener(ev, onInteraction, { capture: true, passive: true });
  }

  // Idle sweep: past the threshold, credit only up to lastInteraction + IDLE_MS
  // and stop the clock until the next interaction.
  window.setInterval(() => {
    if (runningSince !== null && Date.now() - lastInteraction >= IDLE_MS) {
      pauseDwell(Math.min(Date.now(), lastInteraction + IDLE_MS));
    }
  }, 15_000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseDwell();
      flush(true);
    }
    // On visible: stay paused until the next interaction (onInteraction resumes).
  });
  window.addEventListener('pagehide', () => {
    pauseDwell();
    flush(true);
  });

  // ---- click counter: one delegated capture-phase listener ----

  // A tap on a <label>-wrapped control (ui/Checkbox) fires twice: once on the
  // label's contents, then the browser's forwarded click on the hidden input.
  // Both bubble through the same [data-track] element — dedupe by element +
  // a window far shorter than any human double-tap.
  let lastClickEl: Element | null = null;
  let lastClickTs = 0;

  document.addEventListener(
    'click',
    (e) => {
      if (!currentTab) return;
      if (document.documentElement.hasAttribute(HEAT_ACTIVE_ATTR)) return;
      if (!(e.target instanceof Element)) return;
      const el = e.target.closest('[data-track]');
      if (!el) return;
      const name = el.getAttribute('data-track');
      if (!name || !TRACK_NAME_RE.test(name)) return;
      if (el === lastClickEl && e.timeStamp - lastClickTs < 50) return;
      lastClickEl = el;
      lastClickTs = e.timeStamp;
      const page = (pendingClicks[currentTab] ??= {});
      page[name] = (page[name] ?? 0) + 1;
    },
    true,
  );

  // ---- flush triggers ----

  window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);

  // Tab change: settle the outgoing tab's dwell, flush (rate-limited), switch.
  router.subscribe('onResolved', (event) => {
    const next = resolveTab(event.toLocation.pathname);
    if (next === currentTab) return;
    commitDwell();
    flush(false);
    currentTab = next;
  });
}
