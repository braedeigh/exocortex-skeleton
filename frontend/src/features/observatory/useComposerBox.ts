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
 */
import { useCallback, useRef } from 'react';
import { autosizeHeight } from '../phone/phoneLogic';

const MAX_COMPOSER_PX = 132;

export function useComposerBox() {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const autosize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${autosizeHeight(el.scrollHeight, MAX_COMPOSER_PX)}px`;
  }, []);

  /** Put text in the box only if she hasn't typed anything — the draft
   * prefill and the memory-prompt's "give her words back", neither of which
   * may stomp something she's since written. */
  const fillIfEmpty = useCallback(
    (text: string) => {
      const el = inputRef.current;
      if (el && !el.value.trim()) {
        el.value = text;
        autosize();
      }
    },
    [autosize],
  );

  /** Give a failed send's text back, ABOVE anything she's typed since —
   * a refusal must never eat what she wrote. */
  const restore = useCallback(
    (text: string) => {
      const el = inputRef.current;
      if (!el) return;
      el.value = el.value ? `${text}\n${el.value}` : text;
      autosize();
    },
    [autosize],
  );

  /** The send gesture's read-and-clear: the trimmed text, box emptied. */
  const take = useCallback((): string => {
    const el = inputRef.current;
    if (!el) return '';
    const text = el.value.trim();
    el.value = '';
    el.style.height = 'auto';
    return text;
  }, []);

  return { inputRef, autosize, fillIfEmpty, restore, take };
}
