/**
 * streamPacing.ts — pure logic for the observatory's WORD FLOW (her 07-23
 * ask): tokens arrive from the wire in bursts, but the page shouldn't lurch.
 * Incoming text pools in a backlog (the gap between what the wire has sent
 * and what the page has shown), and a ticker releases it a word at a time —
 * spending each burst across the silence that follows it.
 *
 * The release rate is proportional to the backlog (aiming to drain it over
 * ~PACE_HORIZON_MS), so a fast stream never leaves the page minutes behind
 * and a slow one trickles gently instead of stalling. Once the turn ends the
 * horizon shortens hard — a reply shouldn't keep "typing" after the writer
 * has finished. Releases snap forward to word boundaries: whole words read,
 * half words shimmer.
 *
 * This module is arithmetic only; ObservatoryPage owns the interval and the DOM.
 */

/** Ticker granularity. */
export const PACE_TICK_MS = 50;
/** While the turn is writing: drain the backlog over about this long. */
export const PACE_HORIZON_MS = 1200;
/** After the turn ends: the leftover backlog drains over about this long. */
export const PACE_DRAIN_MS = 250;
/** Release-rate floor, chars/sec — keeps a shallow backlog trickling. */
export const PACE_MIN_CPS = 30;
/** Release-rate ceiling while writing, chars/sec — catch-up for a stream
 * that's genuinely far ahead. */
export const PACE_MAX_CPS = 4000;
/** Release-rate ceiling once the turn is OVER. A short reply is mostly
 * backlog at end-of-turn — without this cap it dumps all at once and the
 * whole word-flow feel is lost. ~140cps is a brisk read; her stop button
 * stays the only instant flush. */
export const PACE_DRAIN_MAX_CPS = 140;

export interface PaceState {
  /** Characters of the source string the page has shown. */
  shown: number;
  /** Fractional characters owed but not yet released (sub-char rate × tick). */
  carry: number;
}

/**
 * One tick: how far does the shown frontier advance into `source`?
 * Pure — same inputs, same answer.
 */
export function paceStep(
  source: string,
  state: PaceState,
  writing: boolean,
  dtMs: number,
): PaceState {
  const total = source.length;
  // The source can shrink or reshape (delta buffer folding into the
  // authoritative message) — never point past the end.
  const shown = Math.min(state.shown, total);
  const backlog = total - shown;
  if (backlog <= 0) return { shown, carry: 0 };

  const horizon = writing ? PACE_HORIZON_MS : PACE_DRAIN_MS;
  const ceiling = writing ? PACE_MAX_CPS : PACE_DRAIN_MAX_CPS;
  const cps = Math.min(ceiling, Math.max(PACE_MIN_CPS, (backlog * 1000) / horizon));
  const carry = state.carry + (cps * dtMs) / 1000;
  if (carry < 1) return { shown, carry };

  let next = Math.min(total, shown + Math.floor(carry));
  // Snap forward to a word boundary: extend while we're mid-word (non-space
  // behind AND ahead). Landing at a word START is already a clean edge.
  while (next < total && !/\s/.test(source[next]) && !/\s/.test(source[next - 1] ?? ' ')) {
    next++;
  }
  // The snap forgives any overshoot — start the next tick's debt at zero.
  return { shown: next, carry: 0 };
}

/** How long a released word stays "hot": cascade delay cap (450ms) + the
 * cool-down animation (2200ms), rounded up. A word may not settle into
 * parsed markdown before this — unmounting its span mid-cool snaps it
 * straight to ink (her 07-23 bug report: a new paragraph bleached the
 * previous one white). */
export const COOL_LINGER_MS = 2700;

export interface PaceSample {
  /** Tick timestamp, ms. */
  t: number;
  /** The shown frontier at that tick. */
  shown: number;
}

/** The largest frontier at least `lingerMs` old — everything behind it has
 * finished fading AND cooling, and is safe to settle into markdown. */
export function cooledFrontier(samples: PaceSample[], now: number, lingerMs = COOL_LINGER_MS): number {
  let best = 0;
  for (const s of samples) {
    if (now - s.t >= lingerMs && s.shown > best) best = s.shown;
  }
  return best;
}

/** Drop samples that can no longer move cooledFrontier: everything older
 * than the newest already-cooled sample is redundant. */
export function pruneSamples(samples: PaceSample[], now: number, lingerMs = COOL_LINGER_MS): PaceSample[] {
  let idx = -1;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (now - samples[i].t >= lingerMs) {
      idx = i;
      break;
    }
  }
  return idx <= 0 ? samples : samples.slice(idx);
}

export interface TailWord {
  /** Offset of this token in the full combined string — a STABLE key, so a
   * word's span mounts once and its fade never restarts. */
  key: number;
  /** The word plus the whitespace that precedes it (pre-wrap renders it). */
  text: string;
}

/**
 * Split the visible tail into word tokens for the fade spans. Each token is
 * a word with its leading whitespace attached; `base` is the tail's offset
 * in the full string, so keys stay stable as the settled/tail cut advances.
 */
export function tailWords(tail: string, base: number): TailWord[] {
  const out: TailWord[] = [];
  const re = /\s*\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    out.push({ key: base + m.index, text: m[0] });
  }
  return out;
}
