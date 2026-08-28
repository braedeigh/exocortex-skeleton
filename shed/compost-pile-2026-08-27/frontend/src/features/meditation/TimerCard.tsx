import { useEffect, useRef, useState } from 'react';
import { MED_TYPE_LABELS, MED_TYPE_ORDER, medSlug, medTypeLabel } from './practiceHelpers';
import {
  MED_TIMER_STORAGE_KEY,
  elapsedToDurationMin,
  formatElapsed,
  parseTimerState,
} from './timerMath';
import type { MedTimerState } from './timerMath';
import styles from './TimerCard.module.css';

export interface TimerCardProps {
  /** Fired after Stop with the practice slug + rounded whole minutes. */
  onStop: (type: string, durationMin: number) => void;
}

function readStoredTimer(): MedTimerState | null {
  try {
    return parseTimerState(localStorage.getItem(MED_TIMER_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * "Start a timed session" card / running-timer banner — port of
 * renderMeditationTimer(). The running session lives only in localStorage
 * (`med_timer_state`, same key as the old page) plus a 1s local tick, so
 * the 5s data refetch never touches it. The "Other…" chip replaces the old
 * window.prompt with an inline input (house rule: custom UI over native
 * prompts — see shell/NewSessionDialog).
 */
export function TimerCard({ onStop }: TimerCardProps) {
  const [state, setState] = useState<MedTimerState | null>(readStoredTimer);
  const [now, setNow] = useState<number>(() => Date.now());
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state) return;
    const t = setInterval(() => {
      // Re-read storage each tick like the old _medTimerTick — if another
      // tab/window stopped the timer, this one folds back to the chips.
      const cur = readStoredTimer();
      if (!cur) {
        setState(null);
        return;
      }
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => {
    if (customOpen) customRef.current?.focus();
  }, [customOpen]);

  function start(type: string) {
    const next: MedTimerState = { type, started_at: Date.now() };
    try {
      localStorage.setItem(MED_TIMER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — timer still runs for this mount
    }
    setState(next);
    setNow(Date.now());
  }

  function startCustom() {
    const key = medSlug(customName);
    if (!key) return;
    setCustomOpen(false);
    setCustomName('');
    start(key);
  }

  function stop() {
    const cur = readStoredTimer() ?? state;
    try {
      localStorage.removeItem(MED_TIMER_STORAGE_KEY);
    } catch {
      // ignore
    }
    setState(null);
    if (!cur) return;
    onStop(cur.type, elapsedToDurationMin(Date.now() - cur.started_at));
  }

  if (state) {
    return (
      <div className={styles.running}>
        <div className={styles.runningLeft}>
          <div className={styles.emoji} aria-hidden="true">&#129496;</div>
          <div>
            <div className={styles.runningType}>{medTypeLabel(state.type)}</div>
            <div className={styles.elapsed}>{formatElapsed(now - state.started_at)}</div>
          </div>
        </div>
        <button type="button" className={styles.stopBtn} onClick={stop}>
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Start a timed session</div>
      <div className={styles.chips}>
        {MED_TYPE_ORDER.map((t) => (
          <button key={t} type="button" className={styles.chip} onClick={() => start(t)}>
            {MED_TYPE_LABELS[t]}
          </button>
        ))}
        {customOpen ? (
          <span className={styles.customRow}>
            <input
              ref={customRef}
              className={styles.customInput}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') startCustom();
                if (e.key === 'Escape') {
                  setCustomOpen(false);
                  setCustomName('');
                }
              }}
              placeholder="Custom practice (e.g. tonglen)"
            />
            <button type="button" className={styles.chip} onClick={startCustom}>
              Start
            </button>
          </span>
        ) : (
          <button type="button" className={styles.chipDashed} onClick={() => setCustomOpen(true)}>
            Other&hellip;
          </button>
        )}
      </div>
    </div>
  );
}
