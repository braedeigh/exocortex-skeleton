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
 * fade itself (350ms), rounded up. A word may not settle into parsed markdown
 * before this — unmounting its span mid-fade snaps it straight to ink (her
 * 07-23 bug report: a new paragraph bleached the previous one white).
 *
 * This guards IGNITION only. Cooling is no longer on a clock at all — it's the
 * frost band below, measured in characters — so this no longer has to cover a
 * 2200ms cool-down, and settling waits on whichever of the two is later. */
export const COOL_LINGER_MS = 1100;

/**
 * EMBER SCATTER (her ask, for the step-back view): released words don't ignite
 * in reading order — each one waits a random beat inside this window before it
 * fades up. Because the release frontier keeps moving while they wait, a word
 * several lines further down can catch before one just above it, and the block
 * fills in like a fire taking rather than like a line being typed.
 *
 * It works because a delayed word is invisible but ALREADY LAID OUT (the fade
 * runs with fill-mode `both`, so its `from` state holds through the delay), so
 * nothing reflows when it catches — the sparks land into a page that has
 * already made room for them.
 *
 * Deliberately scoped to the step-back view. Scattered arrival is lovely to
 * WATCH and hostile to READ, and the two are different moments: when she's
 * reading, the ember front glides in order (LETTER_STAGGER_MS in replyViews).
 *
 * Prompt: "I want the words to like, randomly appear a few lines down if that
 * makes sense? To give the effect of an ember burning."
 */
export const EMBER_SPREAD_MS = 900;

/** The ignition floor has to wait out the whole scatter, not just the cascade:
 * a word holding a 900ms ignition delay hasn't started its 350ms fade when a
 * COOL_LINGER_MS-old frontier would already be settling its paragraph into
 * markdown — and settling unmounts the span, which snaps an unlit word
 * straight to ink. */
export const EMBER_LINGER_MS = EMBER_SPREAD_MS + 350 + 250;

/**
 * A word's ignition delay in ember mode, from its own offset — deterministic,
 * so a span keeps the same delay across every re-render of the tail. A random
 * draw would be re-rolled on each render and restart the fade it's meant to be
 * scheduling. Integer avalanche hash (the lowbias32 family) because the keys
 * are character offsets, i.e. nearly sequential: neighbouring words have to
 * land far apart in the window or the "scatter" comes out as a slow ramp.
 */
export function emberDelay(key: number, spreadMs = EMBER_SPREAD_MS): number {
  if (spreadMs <= 0) return 0;
  let h = (key + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = (h ^ (h >>> 15)) >>> 0;
  return h % spreadMs;
}

// ---- the frost band: heat measured in TEXT, not in time ---------------------

/**
 * How far behind the release frontier a word stays warm, in CHARACTERS —
 * about four lines of the 68ch column. The heat is a BAND that rides a fixed
 * distance behind the leading edge, not a timer each word starts when it
 * mounts.
 *
 * That distinction is the whole point. Cooling used to be a 2200ms CSS
 * animation off the word's own arrival, which knows nothing about the page
 * moving: when the stream stalled, a word sat exactly where it landed and
 * cooled in place — the heat left before the word did. Measured in characters
 * instead, a stall means nothing arrives, so nothing cools and the tail simply
 * stays warm until new text pushes it up; a gush cools words at exactly the
 * rate it shoves them up the page. No duration can do that, because the scroll
 * speed is set by the stream and changes constantly.
 *
 * Characters are also free: the release frontier is already state, so this
 * costs no DOM measurement and no per-frame layout read.
 *
 * Prompt that produced it: "the scroll lags behind the frost sometimes, such
 * that the frost disappears before the words scroll up — the frost has to roll
 * with the text scrolling up and out of the way."
 */
export const COOL_DISTANCE_CHARS = 280;

/** When the turn ends there's no more text to push the band along, so the
 * heat left in the tail releases over this instead. The one place the frost
 * is still allowed a clock — and only because the thing that moves it has
 * stopped for good. */
export const COOL_RELEASE_MS = 900;

/**
 * The frost frontier in characters: everything before it has cooled to ink,
 * everything after it is still somewhere in the band. Positional while text
 * is arriving; once the turn has drained, it sweeps forward over
 * COOL_RELEASE_MS so the last words don't sit warm forever.
 */
export function frostFrontier(
  shown: number,
  drainedAt: number | null,
  now: number,
): number {
  const base = shown - COOL_DISTANCE_CHARS;
  if (drainedAt === null) return Math.max(0, base);
  const p = Math.min(1, Math.max(0, (now - drainedAt) / COOL_RELEASE_MS));
  return Math.max(0, base + COOL_DISTANCE_CHARS * p);
}

/**
 * How hot one word is: 1 at the leading edge, falling to 0 as the band passes
 * over it. `end` is the word's last character offset. The component turns this
 * into a colour by mixing the ember toward the theme's ink.
 */
export function wordHeat(end: number, frontier: number, distance = COOL_DISTANCE_CHARS): number {
  if (distance <= 0) return 0;
  const behind = end - frontier;
  if (behind <= 0) return 0;
  return Math.min(1, behind / distance);
}

/** Heat, quantized to a fixed number of steps. Rendering the raw ratio would
 * hand every span in the tail a new inline style on every 50ms tick; stepped,
 * a word's style only changes when it crosses a boundary, so React writes to
 * the DOM a handful of times over a word's whole life instead of ~40. Six
 * steps is under the eye's threshold for banding on a fade this short. */
export const HEAT_STEPS = 6;

export function quantizeHeat(heat: number, steps = HEAT_STEPS): number {
  const clamped = Math.min(1, Math.max(0, heat));
  return Math.round(clamped * (steps - 1)) / (steps - 1);
}

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
