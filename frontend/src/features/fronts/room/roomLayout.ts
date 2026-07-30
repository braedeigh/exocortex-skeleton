/**
 * roomLayout.ts — the geometry behind a front's room (RoomCanvas.tsx).
 *
 * A room is a 12-column grid and every panel is a {x, y, w, h} box measured in
 * GRID CELLS, never pixels. That's the whole reason one saved arrangement holds
 * up at any window width: the cell width is computed from the container, so a
 * panel that sits in the left third stays in the left third on a laptop and on
 * a 27" monitor. Narrow screens skip the geometry entirely and stack the panels
 * in reading order (see `stackOrder`).
 *
 * Server-side clamping lives in routes/fronts.py `_clean_panels` — the same
 * bounds are enforced here so dragging feels solid rather than snapping back
 * after a round trip.
 */

export const ROOM_COLUMNS = 12;
export const ROOM_MAX_ROWS = 60;
export const PANEL_MIN_W = 2;
export const PANEL_MIN_H = 2;
/** Cell height in px. Width is derived from the container, height is fixed —
 * so a room gets taller on a narrow window rather than squashing its panels. */
export const ROW_HEIGHT = 44;
export const ROOM_GAP = 12;
/** Below this the canvas is abandoned for a plain vertical stack: a free
 * canvas needs a pointer and room to drag, and a phone has neither. */
export const CANVAS_MIN_WIDTH = 900;

export interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RoomLayout = Record<string, PanelBox>;

export function clampBox(box: PanelBox): PanelBox {
  const w = Math.max(PANEL_MIN_W, Math.min(Math.round(box.w), ROOM_COLUMNS));
  const h = Math.max(PANEL_MIN_H, Math.min(Math.round(box.h), ROOM_MAX_ROWS));
  return {
    w,
    h,
    x: Math.max(0, Math.min(Math.round(box.x), ROOM_COLUMNS - w)),
    y: Math.max(0, Math.min(Math.round(box.y), ROOM_MAX_ROWS - h)),
  };
}

/**
 * The arrangement a room opens with before it's ever been furnished. Panels
 * come in already-composed rather than in a pile: the first panel takes a tall
 * column down the left (this is the "pinned in the corner" slot), and the rest
 * stack down the remaining width in the order the room declares them.
 */
export function defaultLayout(panelKeys: string[]): RoomLayout {
  const layout: RoomLayout = {};
  if (panelKeys.length === 0) return layout;

  const [first, ...rest] = panelKeys;
  layout[first] = { x: 0, y: 0, w: 4, h: 12 };

  let y = 0;
  const restHeight = rest.length > 1 ? 6 : 12;
  for (const key of rest) {
    layout[key] = { x: 4, y, w: 8, h: restHeight };
    y += restHeight;
  }
  return layout;
}

/**
 * Merge a saved arrangement over the default. A panel the room now offers but
 * the save predates gets its default box, and a saved box for a panel that no
 * longer exists is dropped — so adding or removing a panel never leaves a hole
 * or a ghost in an arrangement someone spent time on.
 */
export function resolveLayout(panelKeys: string[], saved: RoomLayout | undefined): RoomLayout {
  const base = defaultLayout(panelKeys);
  if (!saved) return base;
  const out: RoomLayout = {};
  for (const key of panelKeys) {
    out[key] = saved[key] ? clampBox(saved[key]) : base[key];
  }
  return out;
}

/** Reading order for the stacked (narrow) view: top row first, then left to
 * right — the same order the eye would take across the canvas. */
export function stackOrder(panelKeys: string[], layout: RoomLayout): string[] {
  return [...panelKeys].sort((a, b) => {
    const A = layout[a];
    const B = layout[b];
    if (!A || !B) return 0;
    return A.y - B.y || A.x - B.x;
  });
}

/** Rows the canvas needs to contain every panel, with a little room to drag into. */
export function rowsNeeded(layout: RoomLayout): number {
  const lowest = Object.values(layout).reduce((m, b) => Math.max(m, b.y + b.h), 0);
  return Math.min(ROOM_MAX_ROWS, lowest + 2);
}

/** Pixel width of one column, given the canvas's inner width. */
export function cellWidth(containerWidth: number): number {
  const gaps = ROOM_GAP * (ROOM_COLUMNS - 1);
  return (containerWidth - gaps) / ROOM_COLUMNS;
}

/** Grid cells -> pixel rect, for absolute positioning on the canvas. */
export function boxToPixels(box: PanelBox, containerWidth: number) {
  const cw = cellWidth(containerWidth);
  return {
    left: box.x * (cw + ROOM_GAP),
    top: box.y * (ROW_HEIGHT + ROOM_GAP),
    width: box.w * cw + (box.w - 1) * ROOM_GAP,
    height: box.h * ROW_HEIGHT + (box.h - 1) * ROOM_GAP,
  };
}

/** Pixel delta -> whole grid cells. Used while dragging and resizing. */
export function pixelsToCells(dx: number, dy: number, containerWidth: number) {
  const cw = cellWidth(containerWidth);
  return {
    dx: Math.round(dx / (cw + ROOM_GAP)),
    dy: Math.round(dy / (ROW_HEIGHT + ROOM_GAP)),
  };
}

/** Two layouts are equal when every panel's box matches — used to avoid
 * POSTing a "change" that only moved by zero cells. */
export function sameLayout(a: RoomLayout, b: RoomLayout): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const A = a[k];
    const B = b[k];
    return B && A.x === B.x && A.y === B.y && A.w === B.w && A.h === B.h;
  });
}
