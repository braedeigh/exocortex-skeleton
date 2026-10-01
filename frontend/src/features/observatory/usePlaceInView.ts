/**
 * usePlaceInView.ts — tells the chat whether one thing in it is on screen.
 *
 * The open questions block (QuestionsCard.tsx) scrolls with the chat, so it can
 * be far out of sight. ObservatoryPage.tsx uses this to know when that is the
 * case, and only then offers the small "questions" chip above the message box.
 *
 * Returns a ref to hand to the element being watched, and whether any part of
 * it is showing inside the scrolling chat (`rootRef`, useScrollContract's
 * scroll element).
 */
import { useEffect, useState, type RefObject } from 'react';

export function usePlaceInView(
  rootRef: RefObject<HTMLElement | null>,
): [(element: HTMLElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [inView, setInView] = useState(true);

  // Watch the element against the chat's scroll box. This is an intersection
  // observer: the browser reports when the element enters or leaves the box,
  // so nothing here runs on every scroll. With no element to watch the answer
  // goes back to "in view", so the next element starts from a clean slate. A
  // browser without the observer counts as out of view — the chip then stays
  // offered, which is the safe side.
  useEffect(() => {
    if (!element) {
      setInView(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[entries.length - 1].isIntersecting),
      { root: rootRef.current },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, rootRef]);

  return [setElement, inView];
}
