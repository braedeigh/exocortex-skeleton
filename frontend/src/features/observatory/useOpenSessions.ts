/**
 * useOpenSessions.ts — the React side of openSessionsStore: one hook the
 * observatory calls to HEARTBEAT its open conversation, one the terrain page
 * calls to READ the live set of open sessions. Pure presence math lives in the
 * store; these just drive it on timers and re-render on change.
 */
import { useEffect, useState } from 'react';
import {
  OPEN_SESSION_TTL_MS,
  markSessionOpen,
  openSessionIds,
  subscribeOpenSessions,
} from './openSessionsStore';

/** Well under OPEN_SESSION_TTL_MS, so a still-mounted observatory never lapses
 * out of "open" between beats. */
const HEARTBEAT_MS = 20_000;

/**
 * While a observatory is mounted for `convId`, stamp it open on mount and
 * every ~20s after — but only while the tab is visible, so a backgrounded PWA
 * doesn't keep declaring a session "open" she isn't actually watching. Once the
 * page unmounts (or backgrounds), the heartbeats stop and the stamp ages out of
 * the TTL grace window on its own.
 */
export function useOpenSessionHeartbeat(convId: string | undefined | null): void {
  useEffect(() => {
    if (!convId) return;
    let timer: number | null = null;
    const beat = () => {
      if (document.visibilityState === 'visible') markSessionOpen(convId, new Date().toISOString());
    };
    const start = () => {
      if (timer === null) {
        beat();
        timer = window.setInterval(beat, HEARTBEAT_MS);
      }
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [convId]);
}

/**
 * The live set of conversation ids currently open in the observatory. Re-reads
 * on every presence change (this tab's heartbeats and other tabs' writes) and
 * on a slow tick that lets stale stamps expire out of the set even when nothing
 * new is written. Identity changes only when membership does, so it's safe as a
 * memo/effect dependency.
 */
export function useOpenSessionIds(ttlMs = OPEN_SESSION_TTL_MS): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => openSessionIds(ttlMs));
  useEffect(() => {
    const refresh = () =>
      setIds((prev) => {
        const next = openSessionIds(ttlMs);
        // Keep the same Set object when membership is unchanged, so downstream
        // memos don't churn every tick.
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
        return next;
      });
    const unsubscribe = subscribeOpenSessions(refresh);
    // Half the heartbeat cadence: fast enough that an aged-out session leaves
    // the bar promptly, cheap enough to be invisible.
    const timer = window.setInterval(refresh, HEARTBEAT_MS / 2);
    refresh();
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [ttlMs]);
  return ids;
}
