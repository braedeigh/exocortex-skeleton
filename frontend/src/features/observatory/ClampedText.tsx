/**
 * ClampedText.tsx — a block of text folded to three lines, with a tap to open
 * it up. Shared by the places a card quotes words she may want to read whole:
 * her last message on a session card (SessionCard.tsx LastPrompt) and her own
 * words quoted above a question set (OwnerWords.tsx).
 *
 * The "Show more" button only appears when the text ACTUALLY overflows, and
 * the only way to know that is to ask the browser: with -webkit-line-clamp
 * there's no character count that answers it, because the answer moves with
 * the card's width and her font size. So the clamped text is rendered, its
 * scrollHeight compared against its clientHeight, and re-measured whenever
 * the box is resized — a phone rotation or a lane that reflows changes the
 * answer.
 *
 * Expanded state is deliberately ephemeral: it lives here and resets on
 * reload. Opening a fold is a peek, not a preference — and the cards using it
 * are keyed by conversation id, so it survives every roster poll.
 *
 * The caller styles the text (`className`); the fold and the button are
 * styled here (ClampedText.module.css).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './ClampedText.module.css';

export function ClampedText({ className, children }: { className?: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Measure whether the folded text overflows. It has to run while folded —
  // once expanded, scrollHeight and clientHeight match and the question is
  // moot. That's why `expanded` doesn't trigger a new measurement: the last
  // honest one, taken before she opened it, is the one that stays true.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [children, expanded]);

  // Measure again whenever the box is resized.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!ref.current || expanded) return;
      setOverflows(ref.current.scrollHeight > ref.current.clientHeight + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  return (
    <>
      <div ref={ref} className={[className, expanded ? '' : styles.clamped].filter(Boolean).join(' ')}>
        {children}
      </div>
      {overflows ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          // The fold sits inside cards that answer taps of their own (the
          // question card floats on a tap), so this tap stops here.
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}
