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
 *
 * Every agent conversation lives at the same url — /observatory/<botId>
 * ?conv=<id> — so per-tab dwell alone piles journaling, building and the
 * orchestra into one bucket called "observatory", and the journal (the
 * most-used thing here) reads as unused. So the SAME running clock is
 * committed twice: once to the tab, and once to the conversation id from
 * `?conv=` when there is one. Two views of one measurement, never two
 * measurements — see routes/usage.py for why they don't sum equal.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { convFromLocation, deriveValidTabs, tabFromPathname } from './usageBeacon';

const IDLE_MS = 120_000;
const FLUSH_INTERVAL_MS = 30_000;
/** Never flush more than once per this window — except on pagehide/hidden. */
const MIN_FLUSH_GAP_MS = 5_000;
/** Server-side control-name contract — anything else is dropped client-side too. */
const TRACK_NAME_RE = /^[a-z0-9:._-]{1,60}$/;
/** usageHeat sets this on <html> while the heat view is showing — taps made
 * while inspecting the heat must not pollute the very counts on display. */
const HEAT_ACTIVE_ATTR = 'data-heat-view';

/** One contiguous run of active attention on one (tab, conversation), in
 * epoch ms. The server converts to its own local clock — see
 * attentionstore.py. */
interface Segment {
  tab: string;
  conv: string | null;
  started: number;
  ended: number;
}

interface BatchBody {
  time?: Record<string, number>;
  clicks?: Record<string, Record<string, number>>;
  sessions?: Record<string, number>;
  segments?: Segment[];
}

/** Force-close an open segment at this length so a long unbroken sitting is
 * still partly on the record if the browser dies. Well above a normal reading
 * stretch — the idle pause (2 min) closes segments far more often than this
 * does — so it costs almost nothing in fragmentation. */
const MAX_SEGMENT_MS = 10 * 60_000;
/** Don't let the queue grow without bound if flushes keep failing offline. */
const MAX_QUEUED_SEGMENTS = 500;

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
  let currentConv = convFromLocation(
    router.state.location.pathname,
    router.state.location.search,
  );

  // Accumulators — flushed (and reset) as a whole; dwell keeps sub-second
  // remainders locally so rounding never loses time across flushes.
  const pendingMs: Record<string, number> = {};
  const pendingConvMs: Record<string, number> = {};
  let pendingClicks: Record<string, Record<string, number>> = {};

  let lastInteraction = Date.now();
  /** Timestamp the dwell clock last started/committed at; null = paused. */
  let runningSince: number | null = document.hidden ? null : Date.now();
  let lastFlush = 0;

  // The open segment: where the current unbroken run of attention began, and
  // how far it has been credited. `segStart` null = no run in progress.
  // Because the clock stopping is exactly what closes a segment, the clock
  // ran for the whole of every segment emitted — which is why the server
  // stores no duration and derives it from the two ends.
  let segStart: number | null = null;
  let segEnd = 0;
  let queuedSegments: Segment[] = [];

  /** Close the open segment, if any, and queue it. */
  function closeSegment(): void {
    if (segStart !== null && currentTab && segEnd > segStart) {
      queuedSegments.push({
        tab: currentTab,
        conv: currentConv,
        started: segStart,
        ended: segEnd,
      });
      // Oldest first: if a long offline stretch overflows the queue, the
      // recent past is the part worth keeping.
      if (queuedSegments.length > MAX_QUEUED_SEGMENTS) {
        queuedSegments = queuedSegments.slice(-MAX_QUEUED_SEGMENTS);
      }
    }
    segStart = null;
  }

  /** Fold elapsed running time into the current tab and restart the clock at `upTo`. */
  function commitDwell(upTo = Date.now()): void {
    if (runningSince === null) return;
    const ms = upTo - runningSince;
    if (ms > 0 && currentTab) {
      pendingMs[currentTab] = (pendingMs[currentTab] ?? 0) + ms;
      // Same milliseconds, second view. Never an `else` — the conversation
      // split is a breakdown OF the tab total, not a slice taken out of it.
      if (currentConv) {
        pendingConvMs[currentConv] = (pendingConvMs[currentConv] ?? 0) + ms;
      }
      // Same milliseconds again, third view: the run they belong to. Opens
      // at the moment the clock started, not at `now` — the credited time is
      // the interval [runningSince, upTo], and the segment has to be that
      // same interval or the lane draws in a different place from the total.
      if (segStart === null) segStart = runningSince;
      segEnd = upTo;
      if (segEnd - segStart >= MAX_SEGMENT_MS) {
        closeSegment();
        segStart = upTo;
        segEnd = upTo;
      }
    }
    runningSince = upTo;
  }

  function pauseDwell(upTo = Date.now()): void {
    commitDwell(upTo);
    // The clock stopping IS the end of the run — an idle timeout, a hidden
    // tab. Whatever comes next starts a new segment.
    closeSegment();
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
    const sessions: Record<string, number> = {};
    for (const conv of Object.keys(pendingConvMs)) {
      const secs = Math.floor(pendingConvMs[conv] / 1000);
      if (secs > 0) {
        sessions[conv] = secs;
        pendingConvMs[conv] -= secs * 1000; // same remainder rule as `time`
      }
    }
    const clicks = pendingClicks;
    pendingClicks = {};
    // Only CLOSED segments go — the open one keeps running and is sent by
    // whichever pause, navigation or pagehide ends it. So a flush mid-sitting
    // never chops one sitting into thirty-second pieces.
    const segments = queuedSegments;
    queuedSegments = [];

    const body: BatchBody = {};
    if (Object.keys(time).length > 0) body.time = time;
    if (Object.keys(clicks).length > 0) body.clicks = clicks;
    if (Object.keys(sessions).length > 0) body.sessions = sessions;
    if (segments.length > 0) body.segments = segments;
    if (!body.time && !body.clicks && !body.sessions && !body.segments) return;

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

  // Tab OR conversation change: settle the outgoing dwell, flush
  // (rate-limited), switch. Testing the conversation too is what makes the
  // split correct — moving between two chats never leaves the tab, so a
  // tab-only test would return early here and bank the whole of the
  // conversation you just left onto the one you just opened.
  router.subscribe('onResolved', (event) => {
    const nextTab = resolveTab(event.toLocation.pathname);
    const nextConv = convFromLocation(event.toLocation.pathname, event.toLocation.search);
    if (nextTab === currentTab && nextConv === currentConv) return;
    commitDwell();
    // Settle the run against where she WAS before the labels move; a segment
    // carries its own tab and conv, so closing after the switch would file
    // the time she just spent under the page she just opened.
    closeSegment();
    currentTab = nextTab;
    currentConv = nextConv;
    flush(false);
  });
}
