import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { assistantText, type Turn } from './events';
import {
  COOL_LINGER_MS,
  EMBER_LINGER_MS,
  PACE_TICK_MS,
  cooledFrontier,
  frostFrontier,
  paceStep,
  pruneSamples,
  type PaceSample,
  type PaceState,
} from './streamPacing';

/**
 * useWordFlow.ts — the observatory's WORD FLOW (her 07-23 ask): owns the
 * pacing ticker that releases a streaming reply's text a word at a time
 * (streamPacing.ts owns the arithmetic; this hook owns the interval and the
 * render-driving state).
 *
 * It tracks three frontiers into the reply's text, and they mean different
 * things: `shownChars` is what's on screen at all, `frostChars` is the
 * trailing edge of the warm band (positional — it moves when text arrives,
 * not when time passes), and `cooledChars` is what may collapse into parsed
 * markdown, which needs the frost to have passed AND the fade to have
 * finished.
 */
export function useWordFlow(
  turnsRef: MutableRefObject<Turn[]>,
  writingRef: MutableRefObject<boolean>,
  /** True while the step-back view is up, where words ignite scattered rather
   * than in order (EMBER_SPREAD_MS). A ref rather than a value because the page
   * only learns the answer further down its own hook order — and because the
   * ticker below reads it between renders anyway, exactly like the two above. */
  emberRef?: MutableRefObject<boolean>,
): {
  pacing: boolean;
  paceIdx: number;
  shownChars: number;
  cooledChars: number;
  frostChars: number;
  begin: (idx: number) => void;
  flush: () => void;
} {
  // Word flow (streamPacing.ts): which turn is being paced, how many of its
  // characters are on screen (state — it drives the render), and the ticker's
  // carry bookkeeping (ref). Pacing outlives `streaming` briefly: the leftover
  // backlog fast-drains after the turn ends.
  const [pacing, setPacing] = useState(false);
  const [paceIdx, setPaceIdx] = useState(-1);
  const [shownChars, setShownChars] = useState(0);
  // The cooled frontier: everything behind it may settle into markdown —
  // it has both left the frost band AND finished igniting (see below).
  const [cooledChars, setCooledChars] = useState(0);
  // The frost frontier, in characters: the trailing edge of the warm band.
  // The tail paints its heat from this (streamPacing.ts's wordHeat).
  const [frostChars, setFrostChars] = useState(0);
  const paceRef = useRef<PaceState>({ shown: 0, carry: 0 });
  const sampleRef = useRef<PaceSample[]>([]);
  // When the turn stopped producing text — the moment the frost stops being
  // positional (nothing left to push it) and releases on a clock instead.
  // Null while text is still arriving.
  const drainedAtRef = useRef<number | null>(null);

  // The word-flow ticker: each tick advances the shown frontier into the
  // paced turn's text (streamPacing.ts owns the arithmetic). Keeps running
  // after the turn ends until the leftover backlog fast-drains, then stands
  // down. Missing turn (send failed, reattach reshuffled) → empty source →
  // stands down as soon as writing stops.
  useEffect(() => {
    if (!pacing) return;
    const id = setInterval(() => {
      const t = turnsRef.current[paceIdx];
      const source = t && t.role === 'assistant' ? assistantText(t) : '';
      const st = paceStep(source, paceRef.current, writingRef.current, PACE_TICK_MS);
      paceRef.current = st;
      setShownChars(st.shown);
      // Track the cooled frontier so paragraphs settle only after their
      // embers are out — and keep pacing alive past the last word until it
      // finishes cooling (unmounting early snaps it to ink).
      const now = Date.now();
      // A scattered word waits out its ignition delay before it even begins to
      // fade, so the frontier has to hang back further in ember mode — settling
      // a paragraph early unmounts spans that haven't lit yet and snaps them to
      // ink, the same failure the linger exists to prevent.
      const linger = emberRef?.current ? EMBER_LINGER_MS : COOL_LINGER_MS;
      sampleRef.current = pruneSamples(
        [...sampleRef.current, { t: now, shown: st.shown }],
        now,
        linger,
      );
      // Nothing more is coming and everything's been released: from here the
      // frost has no text left to push it, so it sweeps out on a clock.
      const drained = !writingRef.current && st.shown >= source.length;
      if (drained && drainedAtRef.current === null) drainedAtRef.current = now;
      else if (!drained) drainedAtRef.current = null;
      const frost = frostFrontier(st.shown, drainedAtRef.current, now);
      setFrostChars(frost);
      // A word settles into markdown only once BOTH are true: the frost band
      // has passed over it (position), and it's had long enough to finish
      // igniting (time). Either alone unmounts a span mid-animation and snaps
      // it to flat ink — the frost is positional, but lighting up never was.
      const cooled = Math.min(frost, cooledFrontier(sampleRef.current, now, linger));
      setCooledChars(cooled);
      if (drained && cooled >= source.length) {
        setPacing(false);
      }
    }, PACE_TICK_MS);
    return () => clearInterval(id);
    // turnsRef/writingRef are refs passed in from the page — stable
    // identities, read fresh on every tick; not render-triggering deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pacing, paceIdx]);

  const begin = useCallback((idx: number) => {
    setPaceIdx(idx);
    paceRef.current = { shown: 0, carry: 0 };
    sampleRef.current = [];
    drainedAtRef.current = null;
    setShownChars(0);
    setCooledChars(0);
    setFrostChars(0);
    setPacing(true);
  }, []);

  const flush = useCallback(() => {
    setPacing(false);
  }, []);

  return { pacing, paceIdx, shownChars, cooledChars, frostChars, begin, flush };
}
