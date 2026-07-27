/**
 * openSessionsStore.ts — a LIVE presence registry of which conversations are
 * currently open in the observatory, distinct from openedStore.ts (which is a
 * historical "when did I last open this" map behind the unread dot).
 *
 * Why it exists: the terrain page's agent bar wants to show "active agents" =
 * the sessions she actually has open right now — but the observatory is
 * one-conversation-per-route, there's no tab/dock list to read, and the terrain
 * page lives on a DIFFERENT route (nothing observatory is mounted while she's
 * looking at the map). So a mounted-only signal is useless here.
 *
 * The model instead: an open observatory page HEARTBEATS its conversation id
 * (mount + a periodic tick), stamping localStorage. A session counts as "open"
 * while its stamp is fresh AND for a grace window after the last beat — so
 * popping over to /terrain to watch the map doesn't instantly drop every
 * session out of "active". Stale stamps simply age out; there's no explicit
 * close (the observatory has none), the TTL is the eviction.
 *
 * localStorage (not memory) so it crosses the route change to /terrain and
 * crosses tabs; the pure `freshOpenIds` is what the tests pin.
 */

const STORAGE_KEY = 'exo-open-sessions';

/** The grace window: a session stays "open" this long after its last heartbeat.
 * Generous on purpose — long enough to wander the terrain map and come back
 * without her open sessions blinking out, short enough that a conversation she
 * genuinely left rolls off within the hour. Heartbeat cadence is well under
 * this (see useOpenSessionHeartbeat), so a still-mounted page never lapses. */
export const OPEN_SESSION_TTL_MS = 30 * 60_000;

type OpenMap = Record<string, string>; // convId -> ISO-8601 last-heartbeat

function readOpenMap(): OpenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as OpenMap) : {};
  } catch {
    return {};
  }
}

function writeOpenMap(map: OpenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage disabled — presence just can't be tracked; callers degrade to
    // "no active sessions", never crash.
  }
}

/** Same-tab change signal: the 'storage' event only fires in OTHER tabs, so a
 * heartbeat wouldn't notify a subscriber in the tab that wrote it. This custom
 * event covers that gap; subscribers listen for both. */
const CHANGE_EVENT = 'exo-open-sessions-change';

/** Stamp `convId` as open right now (called on mount and on each heartbeat). */
export function markSessionOpen(convId: string, nowIso: string): void {
  if (!convId) return;
  const map = readOpenMap();
  map[convId] = nowIso;
  writeOpenMap(map);
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // no window (SSR) — nothing to notify
  }
}

/**
 * The set of conversation ids whose last heartbeat is within `ttlMs` of `now`
 * — i.e. currently open. Pure and clock-injected so tests are deterministic;
 * this is the whole contract worth pinning. Entries with an unparseable stamp
 * are treated as not-open rather than throwing.
 */
export function freshOpenIds(map: OpenMap, ttlMs: number, nowMs: number): Set<string> {
  const open = new Set<string>();
  for (const [id, iso] of Object.entries(map)) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && nowMs - t <= ttlMs) open.add(id);
  }
  return open;
}

/** Current open-session ids off live storage — the impure convenience the
 * terrain hook reads on each tick. */
export function openSessionIds(ttlMs = OPEN_SESSION_TTL_MS, nowMs = Date.now()): Set<string> {
  return freshOpenIds(readOpenMap(), ttlMs, nowMs);
}

/** Subscribe to presence changes — fires on this tab's own heartbeats
 * (CHANGE_EVENT) and on other tabs' writes ('storage'). Returns an unsubscribe. */
export function subscribeOpenSessions(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) cb();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, cb);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, cb);
  };
}
