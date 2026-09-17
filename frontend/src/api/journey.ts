/**
 * journey.ts — the browser's half of a trace.
 *
 * Plain English: runtime_trace.py can follow a request through every Python
 * file it touches, but the request arrives at the server from nowhere — the
 * tap, the component that handled it, the fetch it fired, the stream that
 * read the reply back, the render — all of that happens in here, where no
 * Python sensor can see. This module is the sensor for in here.
 *
 * LIVE, by default: while this tab is on screen it keeps a journey open —
 * opening one when the app becomes visible, rolling to a fresh one before the
 * hour is up, closing it when the tab hides — so the deep trace runs exactly
 * while she is looking and never otherwise. `setLive(false)` (the Live switch
 * in the creek / terrain pickers, per device) turns that off; a journey can
 * still be opened by hand then. While one is open:
 *
 *   - every fetch that FOLLOWS SOMETHING SHE DID carries `X-Journey-Id: <id>`,
 *     which is what makes the server record that request as part of the same
 *     journey (server.py's `_trace_begin`), and each such fetch is itself an
 *     event with its timing. "Follows" = a non-GET, or a GET within a few
 *     seconds of a tap / key / route change. The app's background polls are
 *     GETs that follow nothing, so they carry no id, cost no tracing, and stay
 *     out of the record;
 *   - every click / Enter / form submit is an event, stamped with the chain of
 *     React components it landed in (innermost first) — read off the DOM
 *     node's React fiber, which is why vite.config.ts keeps function names in
 *     the production build (`keepNames`), or every component would be `t`;
 *   - every route change is an event.
 *
 * Events are batched and posted to POST /api/observatory/terrain/trace/<id>/
 * browser every couple of seconds and on page hide. Clocks: `t0_ms` is
 * milliseconds since this tab learned the journey was armed; the server keys
 * the browser part off the journey's own armed_at, so the two are off by one
 * request's latency and no more — close enough to place a beat.
 *
 * Deliberately NOT through api/client.ts: the fetches it must see include the
 * raw streaming send in observatory/api.ts, so it patches `window.fetch`
 * itself. Errors are swallowed everywhere; a tracer that can break the thing
 * it is tracing is worse than none.
 *
 * Prompt this was built against: "I want to see every file involved in
 * processing this message, from the buttons I click, to the interface hosting
 * it, to the claude code calls, to where it's stored."
 */
import type { AnyRouter } from '@tanstack/react-router';

const STORAGE_KEY = 'exo-journey';
const LIVE_KEY = 'exo-journey-live';
/** A live journey's window; rolled over before it runs out. */
const LIVE_SECONDS = 3600;
const ROLL_BEFORE_MS = 90_000;
/** A GET this long after the last tap/key/route is "hers"; later, it's a poll. */
const FOLLOWS_MS = 4000;
const FLUSH_MS = 2000;
const MAX_CHAIN = 8;
const MAX_QUEUE = 500;
/** Requests that are the journey's own plumbing, or telemetry — never hops. */
const IGNORE_RE = /^\/api\/(observatory\/terrain\/trace|usage\/)/;
/** Controls that drive the journey itself (the record/stop/play panel) —
 * tapping them is not part of what's being recorded. */
const UI_ATTR = 'data-journey-ui';

export interface JourneyEvent {
  kind: 'click' | 'key' | 'submit' | 'route' | 'fetch';
  components?: string[];
  path?: string;
  label?: string;
  t0_ms: number;
  t1_ms?: number;
  status?: number;
}

interface Active {
  id: string;
  /** performance.now() when this tab learned of the journey. */
  base: number;
  /** epoch ms deadline. */
  until: number;
}

let active: Active | null = null;
let lastActivity = 0;
let opening = false;
let queue: JourneyEvent[] = [];
let flushTimer: number | null = null;
let listeners = new Set<() => void>();

function now(): number {
  return Math.round(performance.now() - (active?.base ?? 0));
}

function persist(): void {
  try {
    if (active) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: active.id, until: active.until, baseEpoch: Date.now() - now() }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable — the journey just won't survive a reload
  }
}

function notify(): void {
  for (const l of listeners) l();
}

/** Begin carrying `id` on every request until `until` (epoch ms). */
export function startJourney(id: string, untilEpochMs: number): void {
  active = { id, base: performance.now(), until: untilEpochMs };
  queue = [];
  persist();
  notify();
}

/** Stop carrying the id. `close` also tells the server the window is done
 * (sendBeacon-safe POST, so it works from pagehide). */
export function stopJourney(close = false): void {
  if (!active) return;
  flush(true);
  const id = active.id;
  active = null;
  persist();
  notify();
  if (close) {
    try {
      const url = `/api/observatory/terrain/trace/${encodeURIComponent(id)}/close`;
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([], { type: 'application/json' }));
      else rawFetch(url, { method: 'POST', credentials: 'include', keepalive: true }).catch(() => undefined);
    } catch {
      // never throw from the tracer
    }
  }
}

// ---- live mode ---------------------------------------------------------------

export function isLive(): boolean {
  try {
    return localStorage.getItem(LIVE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setLive(on: boolean): void {
  try {
    localStorage.setItem(LIVE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
  if (on) ensureLiveJourney();
  else stopJourney(true);
  notify();
}

/** Open a journey if live mode wants one and none is open (or the open one
 * is about to expire). Idempotent; safe to call on every visibility change. */
function ensureLiveJourney(): void {
  if (!isLive() || document.visibilityState !== 'visible' || opening) return;
  const cur = currentJourney();
  if (cur && cur.until - Date.now() > ROLL_BEFORE_MS) return;
  opening = true;
  rawFetch('/api/observatory/terrain/trace/arm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journey: true, seconds: LIVE_SECONDS, label: 'live' }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { journey?: { id: string; until: number } } | null) => {
      if (!data?.journey) return;
      if (cur) stopJourney(true);
      startJourney(data.journey.id, data.journey.until * 1000);
    })
    .catch(() => undefined)
    .finally(() => {
      opening = false;
    });
}

function touch(): void {
  lastActivity = performance.now();
  ensureLiveJourney();
}

/** Does a request "follow" something she did — or is it the app polling? */
function followsHer(method: string): boolean {
  if (method !== 'GET') return true;
  return performance.now() - lastActivity < FOLLOWS_MS;
}

/** The open journey's id, or null. Expiry is checked on every read. */
export function currentJourney(): { id: string; until: number } | null {
  if (active && Date.now() > active.until) stopJourney();
  return active ? { id: active.id, until: active.until } : null;
}

export function subscribeJourney(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function record(ev: JourneyEvent): void {
  if (!currentJourney()) return;
  if (queue.length >= MAX_QUEUE) return;
  queue.push(ev);
  if (flushTimer === null) flushTimer = window.setTimeout(() => flush(false), FLUSH_MS);
}

function flush(final: boolean): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const id = active?.id;
  if (!id || queue.length === 0) return;
  const body = JSON.stringify({ events: queue });
  queue = [];
  const url = `/api/observatory/terrain/trace/${encodeURIComponent(id)}/browser`;
  try {
    if (final && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    // The ORIGINAL fetch, so this post isn't itself recorded.
    rawFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: final,
    }).catch(() => undefined);
  } catch {
    // never let the tracer throw
  }
}

// ---- the component chain ------------------------------------------------------

/**
 * The React components a DOM node sits inside, innermost first. Reads the
 * fiber React hangs on every host node (`__reactFiber$…`) and walks `return`
 * upward, keeping function/class components with a name. Host elements (div,
 * button) and anonymous wrappers are skipped. React's own contexts and
 * providers don't have function types, so they fall out naturally.
 */
export function componentChain(node: Element | null): string[] {
  const out: string[] = [];
  if (!node) return out;
  try {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return out;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fiber: any = (node as any)[key];
    let guard = 0;
    while (fiber && guard++ < 200 && out.length < MAX_CHAIN) {
      const t = fiber.type;
      if (typeof t === 'function') {
        const name: string = t.displayName || t.name || '';
        if (name && !out.includes(name)) out.push(name);
      } else if (t && typeof t === 'object' && typeof t.render === 'function') {
        // forwardRef / memo wrappers carry the inner function on `render`
        const name: string = t.displayName || t.render.displayName || t.render.name || '';
        if (name && !out.includes(name)) out.push(name);
      }
      fiber = fiber.return;
    }
  } catch {
    // a fiber shape we don't understand: an empty chain is the honest answer
  }
  return out;
}

/** What a tap landed on, as a person would name it: the control's text,
 * aria-label, or data-track name — the nearest one walking up. */
function controlLabel(target: Element | null): string {
  let el: Element | null = target;
  let hops = 0;
  while (el && hops++ < 6) {
    const track = el.getAttribute('data-track');
    if (track) return track;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.slice(0, 80);
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 80);
    }
    if (tag === 'input' || tag === 'textarea') {
      return `${tag}${(el as HTMLInputElement).name ? ':' + (el as HTMLInputElement).name : ''}`;
    }
    el = el.parentElement;
  }
  return target ? target.tagName.toLowerCase() : '';
}

// ---- install ------------------------------------------------------------------

let rawFetch: typeof fetch = fetch;

export function installJourney(router: AnyRouter): void {
  if (typeof window === 'undefined') return;

  // Resume a journey a reload interrupted — the send that opens a new
  // conversation navigates, and the window shouldn't close on that.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id: string; until: number; baseEpoch: number };
      if (saved.id && Date.now() < saved.until) {
        active = { id: saved.id, base: performance.now() - (Date.now() - saved.baseEpoch), until: saved.until };
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {
    // ignore
  }

  // Opening the app IS something she did: the boot-time fetches count as
  // following it, even though the router hasn't resolved yet.
  lastActivity = performance.now();

  rawFetch = window.fetch.bind(window);
  window.fetch = function journeyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const j = currentJourney();
    if (!j) return rawFetch(input, init);
    let path = '';
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      path = new URL(url, window.location.origin).pathname;
    } catch {
      return rawFetch(input, init);
    }
    if (!path.startsWith('/api/') || IGNORE_RE.test(path)) return rawFetch(input, init);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!followsHer(method)) return rawFetch(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Journey-Id', j.id);
    const t0 = now();
    const ev: JourneyEvent = { kind: 'fetch', path, label: `${method} ${path}`, t0_ms: t0 };
    return rawFetch(input, { ...init, headers }).then(
      (res) => {
        ev.status = res.status;
        // A streaming response (the send) is "done" when its body closes,
        // not when headers land — that's the whole reply, and it's the span
        // that should reach to the end. Tee the body so the caller's read is
        // untouched.
        if (res.body && res.headers.get('content-type')?.includes('text/event-stream')) {
          const [a, b] = res.body.tee();
          const drain = b.getReader();
          const pump = (): Promise<void> => drain.read().then(({ done }) => (done ? undefined : pump()));
          pump()
            .catch(() => undefined)
            .finally(() => {
              ev.t1_ms = now();
              record(ev);
            });
          return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        ev.t1_ms = now();
        record(ev);
        return res;
      },
      (err) => {
        ev.t1_ms = now();
        ev.status = 0;
        record(ev);
        throw err;
      },
    );
  } as typeof window.fetch;

  const onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(`[${UI_ATTR}]`)) return;
    touch();
    if (!currentJourney()) return;
    record({ kind: 'click', components: componentChain(target), label: controlLabel(target), t0_ms: now() });
  };
  const onKey = (e: KeyboardEvent): void => {
    touch();
    if (!currentJourney() || e.key !== 'Enter') return;
    const target = e.target instanceof Element ? e.target : null;
    record({ kind: 'key', components: componentChain(target), label: `Enter in ${controlLabel(target)}`, t0_ms: now() });
  };
  const onSubmit = (e: Event): void => {
    touch();
    if (!currentJourney()) return;
    const target = e.target instanceof Element ? e.target : null;
    record({ kind: 'submit', components: componentChain(target), label: 'submit', t0_ms: now() });
  };
  window.addEventListener('click', onClick, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, { capture: true, passive: true });
  window.addEventListener('submit', onSubmit, { capture: true, passive: true });

  router.subscribe('onResolved', (event) => {
    touch();
    if (!currentJourney()) return;
    const to = event.toLocation.pathname;
    const from = event.fromLocation?.pathname;
    if (from === to) return;
    record({ kind: 'route', path: to, label: `→ ${to}`, t0_ms: now() });
  });

  // The live rule: on screen -> a journey is open; off screen -> it's closed.
  // A manual (non-live) journey is left alone on hide — she asked for it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flush(true);
      if (isLive()) stopJourney(true);
    } else {
      ensureLiveJourney();
    }
  });
  window.addEventListener('pagehide', () => {
    flush(true);
    if (isLive()) stopJourney(true);
  });
  ensureLiveJourney();
}
