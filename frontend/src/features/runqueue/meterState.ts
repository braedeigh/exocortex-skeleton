/**
 * meterState.ts — the shape of the memory hairline under the Observatory title.
 *
 * Plain English: turns "how much memory is free" into the two numbers a 3px
 * line can actually say — how full the box is, and where the line sits that
 * marks the memory kept back for the site itself. Plus a tone, which is the
 * only thing that ever adds colour.
 *
 * A heartbeat, not a dashboard — the same rule HealthPill.tsx follows: the
 * glance shows SHAPE, never bytes. Raw numbers belong in MemoryPrompt, where
 * she's making an actual decision and a number earns its place.
 *
 * Talks to: memoryPrompt.ts (shares the Headroom type — one truth, so the
 * hairline and the prompt can never disagree) and MemoryMeter.tsx (renders it).
 */
import type { Headroom } from './memoryPrompt';

/** How the meter feels, and the ONLY thing that colours it.
 *
 *   calm     — room for another session. Teal, quiet.
 *   tight    — above the floor, but not by a whole session's worth.
 *   critical — into the reserve kept for the site itself.
 *   paused   — a run hit the usage limit; the queue is cooling off.
 */
export type MeterTone = 'calm' | 'tight' | 'critical' | 'paused';

export interface MeterState {
  /** How full the box is, 0–100. */
  fillPct: number;
  /** Where the floor sits, 0–100 — the mark the fill shouldn't pass. */
  tickPct: number;
  tone: MeterTone;
  /** One line for the tooltip and the screen reader. Still no bytes. */
  label: string;
}

export function meterState(h: Headroom | null | undefined): MeterState | null {
  // No numbers, no meter. Drawing a made-up line would be worse than the
  // header simply not having one.
  if (!h || h.available_mb === null || !h.total_mb) return null;

  const total = h.total_mb;
  const used = Math.max(0, total - h.available_mb);
  const pct = (mb: number) => Math.min(100, Math.max(0, (mb / total) * 100));

  const fillPct = Math.round(pct(used) * 10) / 10;
  const tickPct = Math.round(pct(total - h.floor_mb) * 10) / 10;

  const spare = h.available_mb - h.floor_mb;
  let tone: MeterTone;
  if (h.paused_until) tone = 'paused';
  else if (spare <= 0) tone = 'critical';
  else if (spare < h.per_run_mb) tone = 'tight';
  else tone = 'calm';

  return { fillPct, tickPct, tone, label: meterLabel(h, tone) };
}

function meterLabel(h: Headroom, tone: MeterTone): string {
  const runs = h.running === 1 ? '1 run' : `${h.running} runs`;
  const waiting = h.queued > 0 ? `, ${h.queued} waiting` : '';
  switch (tone) {
    case 'paused':
      return `Queue paused — ${runs}${waiting}`;
    case 'critical':
      return `No room for another session — ${runs}${waiting}`;
    case 'tight':
      return `Getting tight — ${runs}${waiting}`;
    default:
      return `Room to spare — ${runs}${waiting}`;
  }
}

/** True when the meter is worth her attention. A calm box says nothing; the
 * line just sits there being quiet, which is the point. */
export function meterWantsAttention(state: MeterState | null): boolean {
  return !!state && state.tone !== 'calm';
}
