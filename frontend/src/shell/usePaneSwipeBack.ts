import { useEffect, type RefObject } from 'react';

/**
 * usePaneSwipeBack.ts — a two-finger swipe-right over the LEFT pane goes back
 * in that pane instead of navigating the browser.
 *
 * The browser's own swipe-back can't be cancelled from JavaScript; by the time
 * a script hears about it the page is already leaving, and the peel animation
 * started before that. So this doesn't intercept it — it stops the gesture from
 * ever reaching the browser, in CSS: `overscroll-behavior-x: contain` on the
 * pane (SplitLayout.module.css) refuses to chain the horizontal overscroll out
 * to the viewport. The gesture dies at the pane's edge with no animation and
 * nothing to undo, and this hook reads the wheel events it leaves behind.
 *
 * The nice consequence is that "which half am I over" needs no tracking at
 * all: the browser already routes a scroll gesture by what's under the cursor.
 * Swipe over the right half and it's an ordinary browser back, untouched.
 *
 * TWO THINGS IT HAS TO NOT STEAL:
 *  - Vertical scrolling. A trackpad flick is never perfectly axis-aligned, so
 *    a swipe only counts while its horizontal travel clearly dominates.
 *  - Horizontal scrollers inside the pane — a wide code block in a
 *    conversation. If anything between the cursor and the pane can still
 *    scroll further left, that element owns the gesture and this stays out of
 *    it. (Same reason the CSS says `contain` and not `none`: scrolling inside
 *    the pane keeps working, only the chaining OUT of it stops.)
 *
 * It also has to share the pane with useStepBack, which binds its own `wheel`
 * on the conversation scroller and reads deltaY. Wheel events bubble, so both
 * see the same gesture; the dominance check above is what keeps a diagonal
 * flick at the end of a conversation from tripping the peek and a back at once.
 *
 * Touches: SplitLayout.tsx (binds it), paneHistory.ts (what `onBack` moves).
 *
 * Prompt that produced it: "i mostly use the two finger swipe back button" —
 * the one back gesture that can't be intercepted after the fact, only refused
 * before it starts.
 */

/** Horizontal travel that counts as a swipe. A trackpad throws a lot of small
 * deltas, so this is a distance, not a velocity. */
const COMMIT_PX = 90;
/** How much more horizontal than vertical a gesture has to be to count. Below
 * this it's a diagonal scroll and belongs to whatever is scrolling. */
const DOMINANCE = 1.6;
/** A wheel gesture has no end event, so a lull this long ends it — same
 * reasoning (and roughly the same number) as useStepBack's WHEEL_SETTLE_MS. */
const SETTLE_MS = 140;

/** True if anything between `from` and `root` can still scroll further left,
 * i.e. the swipe is somebody else's. */
function consumedByInnerScroller(from: EventTarget | null, root: HTMLElement): boolean {
  let node = from instanceof Node ? from : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollLeft > 0) return true;
    node = node.parentNode;
  }
  return false;
}

export function usePaneSwipeBack(args: {
  ref: RefObject<HTMLElement | null>;
  enabled: boolean;
  onBack: () => void;
}): void {
  const { ref, enabled, onBack } = args;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    // Travel so far in this gesture, and whether it already fired — one back
    // per swipe, however long she keeps pushing.
    let travel = 0;
    let fired = false;
    let settleTimer: number | null = null;

    const endGesture = () => {
      travel = 0;
      fired = false;
      settleTimer = null;
    };

    const onWheel = (e: WheelEvent) => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(endGesture, SETTLE_MS);

      if (fired) return;
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * DOMINANCE) {
        // A vertical stretch mid-gesture means she's scrolling, not swiping.
        travel = 0;
        return;
      }
      // Fingers moving right report negative deltaX: that's the direction that
      // means "back". Anything else resets rather than counting backwards.
      if (e.deltaX > 0) {
        travel = 0;
        return;
      }
      if (consumedByInnerScroller(e.target, el)) {
        travel = 0;
        return;
      }
      travel += -e.deltaX;
      if (travel >= COMMIT_PX) {
        fired = true;
        travel = 0;
        onBack();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      el.removeEventListener('wheel', onWheel);
    };
  }, [ref, enabled, onBack]);
}
