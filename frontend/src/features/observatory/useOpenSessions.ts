/**
 * useOpenSessions.ts — the React side of presence.ts: the hook the observatory
 * calls to HEARTBEAT its open conversation. Pure presence math lives in
 * presence.ts; this just drives it on a timer. (The reading side is
 * presence.ts's openSessionIds, for whoever needs the live set.)
 */
import { useEffect } from 'react';
import { markSessionOpen } from './presence';

/** Well under presence.ts's OPEN_SESSION_TTL_MS, so a still-mounted observatory never lapses
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
