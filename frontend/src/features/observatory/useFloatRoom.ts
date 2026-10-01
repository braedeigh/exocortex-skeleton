/**
 * useFloatRoom.ts — measures how much screen the floated questions card may use.
 *
 * The strip above the message box (ObservatoryPage.module.css .floatDock) holds
 * the questions card when she has floated it (QuestionsCard.tsx). The card
 * grows with its questions, and this keeps it from growing past what she can
 * see: it writes the height of the visible space above the message box onto
 * the strip as the CSS variable `--float-room`, and the stylesheet caps the
 * card at that. Past the cap the questions scroll inside the card, so its top
 * edge never leaves the screen.
 *
 * Returns the ref to put on the strip. ObservatoryPage.tsx is the only caller.
 *
 * Prompt: "i want it to size to the screen if it's that big, with the extra
 * going down at the bottom ... when i open the keyboard, i'm wanting to be able
 * to scroll up to the top of the bubble such that the top of the bubble doesn't
 * go past the top of the screen."
 */
import { useEffect, useRef, type RefObject } from 'react';

/** The least room the card is ever given, so a wrong reading can't shrink it
 * to nothing: enough for its heading and a couple of lines. */
const LEAST_ROOM_PX = 140;

export function useFloatRoom(): RefObject<HTMLDivElement | null> {
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dock = dockRef.current;
    const page = dock?.parentElement;
    if (!dock || !page) return;

    // Measure the visible space above the message box. The strip's own top
    // edge is the bottom of that space. Its top is the top of the page or the
    // top of what the screen is actually showing, whichever is lower: with the
    // phone keyboard open the browser slides the page up behind the screen's
    // top edge, and the visual viewport is how it says by how much.
    const measure = () => {
      const visibleTop = Math.max(page.getBoundingClientRect().top, window.visualViewport?.offsetTop ?? 0);
      const room = dock.getBoundingClientRect().top - visibleTop;
      dock.style.setProperty('--float-room', `${Math.max(LEAST_ROOM_PX, Math.floor(room))}px`);
    };
    measure();

    // Measure again whenever that space can have changed: the page or the
    // message box changes size (a resize observer on each), the keyboard opens
    // or closes, or the browser slides the page.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(page);
    if (dock.nextElementSibling) observer?.observe(dock.nextElementSibling);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    window.addEventListener('scroll', measure);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      window.removeEventListener('scroll', measure);
    };
  }, []);

  return dockRef;
}
