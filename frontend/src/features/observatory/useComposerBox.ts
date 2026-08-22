/**
 * useComposerBox.ts — the compose textarea's mechanics, in one place: the
 * ref, the autosize, and the three ways text enters the box outside her
 * typing. ObservatoryPage had grown three hand-rolled copies of
 * "set the value, reset the height, autosize" (draft prefill, send-failure
 * restore, memory-prompt cancel) — one drifting copy per failure path, which
 * is exactly how a restore path rots unnoticed. Extracted 08-03.
 *
 * The box is deliberately UNCONTROLLED (a ref, not state): the page re-renders
 * per streamed word, and a controlled textarea would re-render the composer on
 * every keystroke on top of that. These helpers are the only writers.
 *
 * The autosize is the composer's hot path — it runs on every keystroke — and
 * measuring a textarea is a trap. Setting height to 'auto' and then reading
 * scrollHeight forces the browser to re-lay-out the page synchronously before
 * it can answer, so the naive version stalls each keypress by a cost that
 * grows with the size of the transcript underneath. It reads as typing lag in
 * a long session and feels fine in a short one. Two guards below keep it off
 * that path: the measurement is coalesced into one animation frame, and the
 * layout-destroying 'auto' reset only happens when the text could have gotten
 * SHORTER (while she's adding characters the box can only grow, and
 * scrollHeight already reports the taller content without it).
 *
 * Prompt that produced this shape: "typing is laggy and the display in the
 * background is very jumpy" — the fix is removing the per-keystroke forced
 * reflow, not changing what the box does.
 */
import { useCallback, useEffect, useRef } from 'react';
import { autosizeHeight, needsAutoReset } from '../phone/phoneLogic';

const MAX_COMPOSER_PX = 132;

export function useComposerBox() {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useRef<number | null>(null);
  // What the last measurement saw, so a keystroke that doesn't change the
  // box's height writes nothing at all.
  const lastLenRef = useRef(0);
  const lastHeightRef = useRef('');

  /** The measurement itself. `force` re-measures from scratch — for the paths
   * that put text in the box themselves, where the growth guard can't know
   * what changed. */
  const applyHeight = useCallback((force: boolean) => {
    const el = inputRef.current;
    if (!el) return;
    const len = el.value.length;
    if (needsAutoReset(len, lastLenRef.current, force)) el.style.height = 'auto';
    lastLenRef.current = len;
    const next = `${autosizeHeight(el.scrollHeight, MAX_COMPOSER_PX)}px`;
    if (next !== lastHeightRef.current) {
      el.style.height = next;
      lastHeightRef.current = next;
    }
  }, []);

  /** The keystroke path: at most one measurement per frame, however fast she
   * types, and never inside the input handler where it would block the
   * character from painting. */
  const autosize = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      applyHeight(false);
    });
  }, [applyHeight]);

  /** Immediate, forced remeasure — for the writers below, which are rare
   * enough to afford it and need the box correct before she looks at it. */
  const resize = useCallback(() => applyHeight(true), [applyHeight]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** Put text in the box only if she hasn't typed anything — the draft
   * prefill and the memory-prompt's "give her words back", neither of which
   * may stomp something she's since written. */
  const fillIfEmpty = useCallback(
    (text: string) => {
      const el = inputRef.current;
      if (el && !el.value.trim()) {
        el.value = text;
        resize();
      }
    },
    [resize],
  );

  /** Give a failed send's text back, ABOVE anything she's typed since —
   * a refusal must never eat what she wrote. */
  const restore = useCallback(
    (text: string) => {
      const el = inputRef.current;
      if (!el) return;
      el.value = el.value ? `${text}\n${el.value}` : text;
      resize();
    },
    [resize],
  );

  /** The send gesture's read-and-clear: the trimmed text, box emptied. */
  const take = useCallback((): string => {
    const el = inputRef.current;
    if (!el) return '';
    const text = el.value.trim();
    el.value = '';
    el.style.height = 'auto';
    // The box is empty and back to one row: say so, or the growth guard would
    // still be holding the sent message's length and skip the next reset.
    lastLenRef.current = 0;
    lastHeightRef.current = '';
    return text;
  }, []);

  return { inputRef, autosize, fillIfEmpty, restore, take };
}
