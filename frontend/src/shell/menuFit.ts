/**
 * menuFit.ts — how tall a dropdown is allowed to be, and which way it opens.
 *
 * THE PROBLEM THIS SOLVES. A dropdown that hangs off a button used to be told
 * `max-height: 70vh` — 70% of the WINDOW. That was right when the only menus
 * lived in a bar pinned to the top of the window. It stopped being right when
 * the desktop became tiled panels: a panel is a box with `overflow: hidden`
 * (panels/PanelFrame.module.css), so a menu sized to the window but living in
 * a half-height panel simply gets its bottom cut off. The menu still thinks
 * it fits, so it never grows a scrollbar, and the items past the cut are
 * unreachable — not scrolled away, GONE.
 *
 * So the height has to come from the box that will actually clip it, not from
 * the window. That box is the nearest ancestor that isn't `overflow: visible`
 * — the panel body in the workspace, the viewport everywhere else.
 *
 * Split in two on purpose: `fitMenu` is arithmetic over four numbers and is
 * checked in menuFit.test.ts, `useMenuFit` is the thin DOM layer that reads
 * those numbers off real elements. Nothing here decides what's IN a menu.
 *
 * Touches: TopTabs.tsx (the dashboard row's More ▾), panels/TabBar.tsx (each
 * panel's set/section ▾), panels/PanelFrame.module.css (the clipping box).
 *
 * Prompt that produced it: "fix it such that the dashboard tabs work again
 * ... it is not showing the different tabs allowing me to go to the 'more'
 * tab. not all are showing in the dashboard at the top of the desktop
 * display specifically."
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

/** Breathing room between the menu's far edge and the edge that clips it. */
const GAP = 8;

/** Below this, opening downward isn't worth it — check whether up is roomier. */
const MIN_USEFUL = 160;

export interface MenuFit {
  /** Pixels the menu may occupy. Pair with `overflow-y: auto` so the overflow
   *  becomes a scrollbar instead of a silent truncation. */
  maxHeight: number;
  /** True when the menu should hang UPWARD from the anchor instead. */
  flipUp: boolean;
}

export interface FitInput {
  /** The anchor (the button) in viewport coordinates. */
  anchorTop: number;
  anchorBottom: number;
  /** The box that will clip the menu, already intersected with the viewport. */
  clipTop: number;
  clipBottom: number;
}

/**
 * Room below the anchor, or above it if that's meaningfully better.
 *
 * Downward is the default and stays the default whenever it's usable, because
 * a menu that jumps to the other side of its button between one open and the
 * next is worse than a slightly shorter menu. Up only wins when down is too
 * cramped to show much AND up is actually roomier.
 *
 * The result is never negative: an anchor scrolled out of its own clipping box
 * yields 0, and a zero-height menu is the honest answer there.
 */
export function fitMenu({ anchorTop, anchorBottom, clipTop, clipBottom }: FitInput): MenuFit {
  const below = Math.max(0, clipBottom - anchorBottom - GAP);
  const above = Math.max(0, anchorTop - clipTop - GAP);
  if (below < MIN_USEFUL && above > below) return { maxHeight: above, flipUp: true };
  return { maxHeight: below, flipUp: false };
}

/** The nearest ancestor that would clip an overflowing child, or null for
 *  "nothing between here and the viewport". Checks both axes because a panel
 *  sets `overflow: hidden` on both, and a horizontal-only scroller (the public
 *  tab row) must not be mistaken for a vertical clip. */
function clippingAncestor(el: Element): Element | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== 'visible') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Measure `anchor`'s room while `open`, and re-measure on resize and scroll.
 *
 * Returns null while closed — the caller then falls back to whatever its
 * stylesheet says, so a menu that never opens costs nothing and a measurement
 * can't go stale between openings.
 */
export function useMenuFit(anchor: HTMLElement | null, open: boolean): MenuFit | null {
  const [fit, setFit] = useState<MenuFit | null>(null);

  const measure = useCallback(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const clipper = clippingAncestor(anchor);
    const box = clipper?.getBoundingClientRect();
    // Intersected with the viewport: a panel taller than the window is still
    // clipped by the window, and a menu sized to the panel would run off screen.
    setFit(
      fitMenu({
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        clipTop: Math.max(0, box?.top ?? 0),
        clipBottom: Math.min(window.innerHeight, box?.bottom ?? window.innerHeight),
      }),
    );
  }, [anchor]);

  useLayoutEffect(() => {
    if (!open) {
      setFit(null);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    // Capture phase for scroll: it doesn't bubble, and the thing that moves the
    // anchor is usually an ancestor scrolling, not the window.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  return fit;
}
