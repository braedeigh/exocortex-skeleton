import { useCallback, useEffect, useRef, useState } from 'react';
import { applyStatsEvent, startTurnStats, type TurnStats } from './turnStats';

/**
 * useTurnStats.ts — the observatory's working line state: word · elapsed ·
 * tokens · thought (turnStats.ts). Owns the stats value plus the clock that
 * keeps its elapsed-seconds display ticking between events.
 */
export function useTurnStats(active: boolean): {
  stats: TurnStats | null;
  start: (now: number) => void;
  apply: (event: Record<string, unknown>, now: number) => void;
  reset: () => void;
} {
  // The working line (turnStats.ts): word · elapsed · tokens · thought.
  const [stats, setStats] = useState<TurnStats | null>(null);
  const statsRef = useRef<TurnStats | null>(null);
  const [, setClockTick] = useState(0);

  // The working line's clock: re-render while streaming so the elapsed
  // seconds tick even when no tokens are arriving (tool time). 250ms, not
  // 1s: the display derives from Date.now() so a dropped frame self-corrects
  // instead of visibly stuttering the counter.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [active]);

  const start = useCallback((now: number) => {
    const s = startTurnStats(now);
    statsRef.current = s;
    setStats(s);
  }, []);

  const apply = useCallback((event: Record<string, unknown>, now: number) => {
    if (statsRef.current) {
      statsRef.current = applyStatsEvent(statsRef.current, event, now);
      setStats(statsRef.current);
    }
  }, []);

  const reset = useCallback(() => {
    setStats(null);
    statsRef.current = null;
  }, []);

  return { stats, start, apply, reset };
}
