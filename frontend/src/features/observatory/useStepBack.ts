import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * useStepBack.ts — pull past the end of the conversation to stand back and
 * watch the terrain instead of reading over it.
 *
 * The problem it answers: the map behind the Observatory and the words on top
 * of it both want the whole screen, and every treatment that lets them share
 * it (the backdrop's blur, the column's halo) is a permanent compromise. This
 * lets them TAKE TURNS instead. Reading gets the full screen while she reads;
 * the organism gets it the moment she asks, at full strength, captioned.
 *
 * THE GESTURE. At the bottom of the conversation, keep pulling — swipe up on
 * touch, wheel down on a trackpad. That overscroll is dead space otherwise, so
 * nothing is taken away from her to make room for it. The pull is progressive
 * and reversible: it lifts the backdrop's blur as it goes, so a small pull is
 * a PEEK (the map sharpens under her thumb and springs back when she lets go)
 * and only a pull past the commit line settles into the view. A gesture you
 * can peek at teaches itself; a binary one has to be taught.
 *
 * What the pull deliberately does NOT do is move the layout. Reflowing the
 * conversation on every frame of a drag is the expensive kind of animation;
 * blur is a compositor filter. So the drag drives light only, and the layout
 * change happens once, on commit, in a single eased step.
 *
 * WHAT IT SUSPENDS. While the view is up the scroll contract in
 * useScrollContract (follow-then-lock, parked reading, the unread anchor) is
 * beside the point — she isn't reading in depth, she's watching — so the page
 * simply pins to the bottom and stays there while text prints into the strip.
 * That's the whole of "keeps coming down but auto scrolling up to preserve the
 * view": the newest line stays put and the map above it never moves. Exiting
 * hands the contract back untouched.
 *
 * Prompt that produced it: "scroll up hard on the bottom and it shows it
 * without the frost and a little bit of the text comes down on the bottom and
 * if it's printing new text it keeps coming down but auto scrolling up to
 * preserve the view. Maybe with the names of the folders or files also shown."
 */

/** How much overscroll counts as a full pull. Short enough to reach in one
 * thumb travel, long enough that ordinary momentum at the end of a scroll
 * doesn't trip it. */
const PULL_RANGE_PX = 150;
/** How much of the pull has to survive to the release to commit. Past half, so
 * an accidental nudge falls back and a deliberate pull carries. */
const COMMIT_AT = 0.55;
/** A wheel gesture has no touchend, so a lull this long counts as the release. */
const WHEEL_SETTLE_MS = 140;
/** Downward drag on the exposed map that dismisses the view. */
const DISMISS_PX = 48;
/** Treated as "at the end" — sub-pixel scroll heights mean this is never
 * exactly zero. */
const BOTTOM_SLOP_PX = 4;

export function useStepBack(args: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pageRef: RefObject<HTMLDivElement | null>;
  /** Re-pins the conversation to its newest line. Called on both edges of the
   * transition: entering, because the strip is a different height than the
   * page she was reading, and leaving, for the same reason in reverse. */
  pinToBottom: () => void;
  /** False when there's no map behind the page to step back to — she's turned
   * the backdrop off (features/terrain/backdropPref.ts). The gesture stops
   * being bound at all, and a view that's already up closes, because the whole
   * of what it uncovers is the terrain. */
  enabled?: boolean;
}): { active: boolean; exit: () => void } {
  const { scrollRef, pageRef, pinToBottom, enabled = true } = args;
  const [active, setActive] = useState(false);

  // The pull lives in a ref and is written straight to a CSS custom property
  // on the page element. Nothing here re-renders React per frame — the whole
  // peek is one inherited variable driving a filter.
  const pullRef = useRef(0);
  const activeRef = useRef(false);
  activeRef.current = active;

  const setPull = useCallback(
    (v: number) => {
      const next = Math.max(0, Math.min(1, v));
      if (next === pullRef.current) return;
      pullRef.current = next;
      pageRef.current?.style.setProperty('--step-pull', String(next));
    },
    [pageRef],
  );

  const commit = useCallback(() => {
    pullRef.current = 0;
    // Hand the variable back to the stylesheet: the active class pins it at 1,
    // and an inline value would outrank it and strand the map half-blurred.
    pageRef.current?.style.removeProperty('--step-pull');
    setActive(true);
  }, [pageRef]);

  const exit = useCallback(() => {
    pullRef.current = 0;
    pageRef.current?.style.removeProperty('--step-pull');
    setActive(false);
  }, [pageRef]);

  // Both edges of the transition change how tall the conversation is, so the
  // newest line has to be found again on the other side.
  useEffect(() => {
    const id = window.setTimeout(pinToBottom, 0);
    return () => window.clearTimeout(id);
  }, [active, pinToBottom]);

  // Escape always leaves. A view entered by a gesture still needs a way out
  // that doesn't require knowing the gesture.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, exit]);

  // Map turned off mid-view: put the conversation back rather than leaving her
  // holding a strip of text over nothing.
  useEffect(() => {
    if (!enabled && activeRef.current) exit();
  }, [enabled, exit]);

  // The pull itself, bound to the scroller.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const atEnd = () => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX;

    let settleTimer: number | null = null;
    const settle = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (pullRef.current >= COMMIT_AT) commit();
      else setPull(0);
    };

    const onWheel = (e: WheelEvent) => {
      if (activeRef.current) return;
      // Scrolling back up is a retreat from the gesture, not a part of it.
      if (e.deltaY <= 0) {
        setPull(0);
        return;
      }
      if (!atEnd()) return;
      setPull(pullRef.current + e.deltaY / PULL_RANGE_PX);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, WHEEL_SETTLE_MS);
    };

    let lastY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (activeRef.current) return;
      const y = e.touches[0]?.clientY;
      if (y === undefined || lastY === null) return;
      // Finger travelling up is positive: that's the direction that carries
      // the conversation past its own end.
      const up = lastY - y;
      lastY = y;
      if (!atEnd()) {
        setPull(0);
        return;
      }
      setPull(pullRef.current + up / PULL_RANGE_PX);
    };
    const onTouchEnd = () => {
      lastY = null;
      if (!activeRef.current) settle();
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [scrollRef, setPull, commit, enabled]);

  return { active, exit };
}

/**
 * Handlers for the exposed map while the view is up: dragging back down, or
 * wheeling back up, puts the conversation away again — the same motion that
 * opened it, reversed. A tap works too, and is what the hint names, because a
 * reversal gesture is only obvious once you've already found it.
 */
export function useStepBackDismiss(exit: () => void): {
  onClick: () => void;
  onWheel: (e: React.WheelEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
} {
  const fromY = useRef<number | null>(null);
  return {
    onClick: exit,
    onWheel: (e) => {
      if (e.deltaY < 0) exit();
    },
    onTouchStart: (e) => {
      fromY.current = e.touches[0]?.clientY ?? null;
    },
    onTouchMove: (e) => {
      const y = e.touches[0]?.clientY;
      if (y === undefined || fromY.current === null) return;
      if (y - fromY.current > DISMISS_PX) {
        fromY.current = null;
        exit();
      }
    },
  };
}
