import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { assistantText, type Turn } from './events';
import {
  PACE_TICK_MS,
  cooledFrontier,
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
 */
export function useWordFlow(
  turnsRef: MutableRefObject<Turn[]>,
  writingRef: MutableRefObject<boolean>,
): {
  pacing: boolean;
  paceIdx: number;
  shownChars: number;
  cooledChars: number;
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
  // The cooled frontier: everything behind it finished its ember fade and
  // may settle into markdown (see COOL_LINGER_MS).
  const [cooledChars, setCooledChars] = useState(0);
  const paceRef = useRef<PaceState>({ shown: 0, carry: 0 });
  const sampleRef = useRef<PaceSample[]>([]);

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
      sampleRef.current = pruneSamples([...sampleRef.current, { t: now, shown: st.shown }], now);
      const cooled = cooledFrontier(sampleRef.current, now);
      setCooledChars(cooled);
      if (!writingRef.current && st.shown >= source.length && cooled >= source.length) {
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
    setShownChars(0);
    setCooledChars(0);
    setPacing(true);
  }, []);

  const flush = useCallback(() => {
    setPacing(false);
  }, []);

  return { pacing, paceIdx, shownChars, cooledChars, begin, flush };
}
