/**
 * timerMath.ts — pure timer logic, ported from static/js/meditation.js
 * (_medTimerState / medFormatElapsed / _stopMedTimer's rounding).
 *
 * The running timer lives ONLY in localStorage under `med_timer_state`
 * (same key as the old page, so an in-flight session survives the
 * migration) — never in the query cache, so the 5s poll can't disturb it.
 */

export const MED_TIMER_STORAGE_KEY = 'med_timer_state';

export interface MedTimerState {
  type: string;
  started_at: number;
}

/** Parse the raw localStorage value; null on anything malformed. */
export function parseTimerState(raw: string | null): MedTimerState | null {
  if (!raw) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const { type, started_at } = obj as { type?: unknown; started_at?: unknown };
    if (!type || !started_at) return null;
    return { type: String(type), started_at: Number(started_at) };
  } catch {
    return null;
  }
}

/** ms -> "m:ss", or "h:mm:ss" once over an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Stop rounds to whole minutes but never logs less than 1. */
export function elapsedToDurationMin(ms: number): number {
  return Math.max(1, Math.round(ms / 60000));
}
