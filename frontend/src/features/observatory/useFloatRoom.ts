/**
 * useFloatRoom.ts — measures how much screen the floated questions card may use.
 *
 * The strip above the message box (ObservatoryPage.module.css .floatDock) holds
 * the questions card when she has floated it (QuestionsCard.tsx). The card
 * grows with its questions, and this keeps it from growing past what she can
 * see: it writes the height of the visible space above the message box onto
 * the strip as the CSS variable `--float-room`, and the stylesheet caps the
 * card at that. Past the cap the questions scroll inside the card, so its top
 * edge never leaves the screen. The room never reads below a floor
 * (LEAST_ROOM_PX), so even a wrong reading leaves questions showing under the
 * heading.
 *
 * Returns the ref to put on the strip. ObservatoryPage.tsx is the only caller;
 * floatRoomPx is the arithmetic, kept apart so useFloatRoom.test.ts can pin it.
 *
 * Prompts: "i want it to size to the screen if it's that big, with the extra
 * going down at the bottom ... when i open the keyboard, i'm wanting to be able
 * to scroll up to the top of the bubble such that the top of the bubble doesn't
 * go past the top of the screen.", then "This needs to be open when I click the
 * thingy" (on a phone screenshot, keyboard open, where the floated card showed
 * only its heading).
 */
import { useEffect, useRef, type RefObject } from 'react';

/** The least room the strip is ever given, so a wrong reading can't close the
 * card. The strip holds more than the card: its own padding (16px) and, often,
 * the ↓ latest row (52px with its gap) on top. 240 leaves the card its heading
 * (68px) and about four lines of questions. It is only a cap, so a short set
 * still takes just the room it needs. */
const LEAST_ROOM_PX = 240;

/** The visible space above the message box, from heights alone.
 *
 * Every number is a distance between two edges or a height, never a position
 * against the screen. That is on purpose: with the phone keyboard open, iOS
 * slides the page up and the positions it reports for the page and for the
 * visible screen disagree about where "top" is — the old measurement took the
 * screen's top from one and the strip's from the other, read a 400px space as
 * 70px, and squashed the card to its heading. Heights can't disagree that way.
 *
 * The space is the smaller of two: how far the strip sits below the top of the
 * page (no keyboard — the page is all on screen), and the visible height less
 * what sits below the strip (keyboard open — the browser keeps the message box
 * at the bottom of what's visible, so the strip is that far up from it). */
export function floatRoomPx(edges: {
  pageTop: number;
  pageBottom: number;
  dockTop: number;
  visibleHeight: number;
}): number {
  const belowDock = edges.pageBottom - edges.dockTop;
  const room = Math.min(edges.dockTop - edges.pageTop, edges.visibleHeight - belowDock);
  return Math.max(LEAST_ROOM_PX, Math.floor(room));
}

export function useFloatRoom(): RefObject<HTMLDivElement | null> {
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dock = dockRef.current;
    const page = dock?.parentElement;
    if (!dock || !page) return;

    // Measure the visible space above the message box (floatRoomPx) and hand
    // it to the stylesheet. The visual viewport is the part of the page the
    // screen actually shows, which shrinks when the keyboard opens.
    const measure = () => {
      const pageBox = page.getBoundingClientRect();
      const room = floatRoomPx({
        pageTop: pageBox.top,
        pageBottom: pageBox.bottom,
        dockTop: dock.getBoundingClientRect().top,
        visibleHeight: window.visualViewport?.height ?? window.innerHeight,
      });
      dock.style.setProperty('--float-room', `${room}px`);
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
