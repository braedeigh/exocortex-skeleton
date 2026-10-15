import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react';

/**
 * tabDrag.ts — picking a tab up and putting it down somewhere else, by mouse
 * or by finger, within one panel's row or onto another panel's.
 *
 * WHY NOT THE BROWSER'S OWN DRAG. HTML5 `draggable` doesn't work by touch at
 * all, and it can't be told "a tap is a click, a hold is a drag". So this is
 * built on pointer events:
 *
 *   MOUSE  press, then move about 6px — that's a drag. Less than that and
 *          letting go is an ordinary click.
 *   TOUCH  press and HOLD still for a moment — that's a drag. Moving the
 *          finger straight away is a swipe, which scrolls the row sideways as
 *          it always did, and lifting quickly is a tap.
 *
 * WHERE IT LANDS is found by asking the page what's under the pointer
 * (document.elementFromPoint) rather than by every tab listening for it.
 * Each panel's row says which panel it belongs to (`data-tab-row`), and each
 * tab which group it's in (`data-tab-kind`), so one lookup answers both
 * "which row" and "between which two tabs" — across panels too, which is what
 * lets a tab be dragged from one side of the split to the other.
 *
 * The drag itself (what's lifted, where it would land) is held by
 * Workspace.tsx and handed to every row, so the row being dragged OVER can
 * draw the drop line even though the drag started in another one.
 *
 * Touches: TabBar.tsx (starts drags, draws the drop line), Workspace.tsx
 * (holds the drag, applies a drop onto another panel).
 *
 * Prompt that produced it: "i want to be able to drag to rearrange them ...
 * or be draggable between the split screen windows."
 */

/** What was picked up. `index` is its place within its own group. */
export interface TabDragSource {
  panelId: string;
  kind: 'anchor' | 'open';
  index: number;
  url: string;
}

/** Where a dragged tab would go: a row, and the gap before tab `index` of
 *  the same group (index = group length means after the last one). */
export interface DropSlot {
  panelId: string;
  index: number;
}

export interface TabDrag extends TabDragSource {
  over: DropSlot | null;
}

/** How far a mouse moves before a press becomes a drag. */
const MOUSE_SLOP_PX = 6;
/** How far a finger may wander during the hold before it counts as a swipe. */
const TOUCH_SLOP_PX = 8;
/** How long a finger holds still before it picks the tab up. Shorter than the
 *  browser's own long-press menu, so that never gets a chance to open. */
const TOUCH_HOLD_MS = 300;

/** Which gap `x` falls in, given the horizontal middle of each tab in order. */
export function insertionIndex(middles: number[], x: number): number {
  let i = 0;
  while (i < middles.length && x > middles[i]) i += 1;
  return i;
}

/** Turn a gap into the position the tab ends up at within its own list — the
 *  gap after itself and the gap before itself both mean "stay". */
export function gapToPosition(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** The row and gap under the pointer, or null off every row. Pinned tabs only
 *  rearrange within their own row; they never move to another panel. */
function slotUnder(x: number, y: number, source: TabDragSource): DropSlot | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tab-row]');
  const panelId = row?.dataset.tabRow;
  if (!row || !panelId) return null;
  if (source.kind === 'anchor' && panelId !== source.panelId) return null;
  const tabs = Array.from(row.querySelectorAll<HTMLElement>(`[data-tab-kind="${source.kind}"]`));
  const middles = tabs.map((tab) => {
    const rect = tab.getBoundingClientRect();
    return rect.left + rect.width / 2;
  });
  return { panelId, index: insertionIndex(middles, x) };
}

/**
 * The drag gesture for one row. `start` goes on each tab's pointerdown;
 * `swallowClick` on the row's click capture, so letting go after a drag
 * doesn't also count as clicking the tab.
 */
export function useTabDrag(options: {
  rowRef: RefObject<HTMLElement | null>;
  onDrag: (drag: TabDrag | null) => void;
  onDrop: (source: TabDragSource, slot: DropSlot) => void;
}) {
  // The handlers outlive renders, so they read the callbacks through a ref.
  const latest = useRef(options);
  latest.current = options;
  const dragging = useRef(false);
  const justDropped = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  /* Stop the row scrolling while a finger is dragging a tab. This has to be a
     non-passive touchmove listener that is ALREADY there when the finger
     lands — one added mid-gesture is too late for the browser to wait on, and
     pointer events alone can't stop a scroll. */
  const { rowRef } = options;
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const holdStill = (e: TouchEvent) => {
      if (dragging.current) e.preventDefault();
    };
    const noMenu = (e: Event) => {
      if (dragging.current) e.preventDefault();
    };
    row.addEventListener('touchmove', holdStill, { passive: false });
    row.addEventListener('contextmenu', noMenu);
    return () => {
      row.removeEventListener('touchmove', holdStill);
      row.removeEventListener('contextmenu', noMenu);
    };
  }, [rowRef]);

  // A row unmounted mid-drag mustn't leave window listeners behind.
  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback((e: PointerEvent<HTMLElement>, source: TabDragSource) => {
    if (e.button !== 0 || cleanup.current) return;
    const element = e.currentTarget;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType !== 'mouse';
    const startX = e.clientX;
    const startY = e.clientY;
    let over: DropSlot | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    // Pick it up: from here on the pointer is carrying a tab.
    const begin = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      dragging.current = true;
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // The pointer already went away; the up/cancel handler tidies.
      }
      latest.current.onDrag({ ...source, over: null });
    };

    const finish = () => {
      if (holdTimer) clearTimeout(holdTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      cleanup.current = null;
      if (dragging.current) {
        dragging.current = false;
        latest.current.onDrag(null);
      }
    };

    const onMove = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging.current) {
        const distance = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        // A finger that moves before the hold is up is scrolling, not dragging.
        if (isTouch && distance > TOUCH_SLOP_PX) finish();
        else if (!isTouch && distance > MOUSE_SLOP_PX) begin();
        return;
      }
      ev.preventDefault();
      const next = slotUnder(ev.clientX, ev.clientY, source);
      if (next?.panelId !== over?.panelId || next?.index !== over?.index) {
        over = next;
        latest.current.onDrag({ ...source, over });
      }
    };

    const onUp = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dropped = dragging.current;
      finish();
      if (!dropped) return;
      // The click that follows this pointerup belongs to the drag, not the tab.
      justDropped.current = true;
      setTimeout(() => {
        justDropped.current = false;
      }, 0);
      if (over) latest.current.onDrop(source, over);
    };

    const onCancel = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };

    if (isTouch) holdTimer = setTimeout(begin, TOUCH_HOLD_MS);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    cleanup.current = finish;
  }, []);

  const swallowClick = useCallback((e: MouseEvent) => {
    if (!justDropped.current) return;
    justDropped.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { start, swallowClick };
}
