/**
 * MemoryMeter.tsx — the hairline under the Observatory title.
 *
 * Plain English: a 3px line saying how full the box is, sitting just under the
 * page title so it reads as part of the room rather than a widget parked on top
 * of her sessions. On a healthy box it's a quiet teal line and nothing else —
 * no numbers, no words. It only speaks up when things tighten, and tapping it
 * opens the actual figures.
 *
 * A heartbeat, not a dashboard — the rule the research HealthPill already
 * follows. The glance shows shape; numbers live in the expansion (she asked for
 * them) and in MemoryPrompt (she's deciding something).
 *
 * Talks to: meterState.ts (all the rules, tested on their own), api.ts
 * (fetchHeadroom), and routes/run_queue.py behind that.
 */
import { useEffect, useState } from 'react';
import { fetchHeadroom } from './api';
import type { Headroom } from './memoryPrompt';
import { meterState, meterWantsAttention } from './meterState';
import styles from './MemoryMeter.module.css';

/** How often the line refreshes. Slow on purpose: this is ambient, and a
 * fast poll would make a quiet line twitch in her peripheral vision. */
const POLL_MS = 20000;

export function MemoryMeter() {
  const [headroom, setHeadroom] = useState<Headroom | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const h = await fetchHeadroom();
      if (alive) setHeadroom(h);
    };
    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const state = meterState(headroom);
  // No numbers means no line. An empty header beats an invented one, and it's
  // also what a box without /proc (or a server that hasn't got the endpoint
  // yet) should look like: nothing at all.
  if (!state) return null;

  const loud = meterWantsAttention(state);

  return (
    <div>
      <button
        type="button"
        className={`${styles.strip} ${styles[state.tone]}`}
        onClick={() => setOpen((v) => !v)}
        title={state.label}
        aria-label={state.label}
        aria-expanded={open}
      >
        <div className={styles.track}>
          <div
            className={styles.fill}
            style={{ transform: `scaleX(${state.fillPct / 100})` }}
          />
          <div className={styles.tick} style={{ left: `${state.tickPct}%` }} />
        </div>
        {loud && (
          <div className={`${styles.note} ${styles.noteLoud}`}>{state.label}</div>
        )}
      </button>

      {open && headroom && (
        <div className={styles.detail}>
          <div className={styles.row}>
            <span className={styles.rowKey}>Free</span>
            <span className={styles.rowVal}>
              {headroom.available_mb}MB of {headroom.total_mb}MB
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowKey}>Kept for the site</span>
            <span className={styles.rowVal}>{headroom.floor_mb}MB</span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowKey}>Background runs</span>
            <span className={styles.rowVal}>
              {headroom.running} of {headroom.cap}
              {headroom.queued > 0 ? ` · ${headroom.queued} waiting` : ''}
            </span>
          </div>
          {headroom.pause_reason && (
            <div className={styles.row}>
              <span className={styles.rowKey}>Paused</span>
              <span className={styles.rowVal}>{headroom.pause_reason}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
