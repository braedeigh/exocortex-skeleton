import { describe, expect, it } from 'vitest';
import {
  PANEL_MIN_H,
  PANEL_MIN_W,
  ROOM_COLUMNS,
  clampBox,
  defaultLayout,
  resolveLayout,
  rowsNeeded,
  sameLayout,
  stackOrder,
  type RoomLayout,
} from './roomLayout';

describe('clampBox', () => {
  it('pulls an over-wide panel back onto the grid', () => {
    expect(clampBox({ x: 11, y: 0, w: 99, h: 4 })).toEqual({ x: 0, y: 0, w: ROOM_COLUMNS, h: 4 });
  });

  it('enforces the minimum size', () => {
    const box = clampBox({ x: 0, y: 0, w: 0, h: 0 });
    expect(box.w).toBe(PANEL_MIN_W);
    expect(box.h).toBe(PANEL_MIN_H);
  });

  it('never lets a panel start off the left or top edge', () => {
    expect(clampBox({ x: -4, y: -9, w: 3, h: 3 })).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps a panel fully on-grid when dragged past the right edge', () => {
    const box = clampBox({ x: 10, y: 0, w: 4, h: 3 });
    expect(box.x + box.w).toBeLessThanOrEqual(ROOM_COLUMNS);
  });
});

describe('defaultLayout', () => {
  it('gives the first panel the tall left column — the pinned corner', () => {
    const layout = defaultLayout(['todos', 'buy', 'inventory']);
    expect(layout.todos).toEqual({ x: 0, y: 0, w: 4, h: 12 });
  });

  it('stacks the rest down the remaining width without overlapping', () => {
    const layout = defaultLayout(['todos', 'buy', 'inventory']);
    expect(layout.buy.x).toBe(4);
    expect(layout.inventory.x).toBe(4);
    expect(layout.inventory.y).toBe(layout.buy.y + layout.buy.h);
  });

  it('is empty for a room with no panels', () => {
    expect(defaultLayout([])).toEqual({});
  });
});

describe('resolveLayout', () => {
  it('falls back to the default when nothing is saved', () => {
    expect(resolveLayout(['todos'], undefined)).toEqual(defaultLayout(['todos']));
  });

  it('keeps the saved box for a panel and defaults one the save predates', () => {
    const saved: RoomLayout = { todos: { x: 6, y: 2, w: 3, h: 5 } };
    const out = resolveLayout(['todos', 'buy'], saved);
    expect(out.todos).toEqual({ x: 6, y: 2, w: 3, h: 5 });
    expect(out.buy).toEqual(defaultLayout(['todos', 'buy']).buy);
  });

  it('drops a saved box for a panel the room no longer offers', () => {
    const saved: RoomLayout = {
      todos: { x: 0, y: 0, w: 4, h: 4 },
      gone: { x: 5, y: 5, w: 4, h: 4 },
    };
    expect(Object.keys(resolveLayout(['todos'], saved))).toEqual(['todos']);
  });

  it('clamps a saved box that is off-grid', () => {
    const out = resolveLayout(['todos'], { todos: { x: 40, y: 0, w: 40, h: 3 } });
    expect(out.todos.x + out.todos.w).toBeLessThanOrEqual(ROOM_COLUMNS);
  });
});

describe('stackOrder', () => {
  it('reads top row first, then left to right', () => {
    const layout: RoomLayout = {
      right: { x: 6, y: 0, w: 4, h: 3 },
      bottom: { x: 0, y: 8, w: 4, h: 3 },
      left: { x: 0, y: 0, w: 4, h: 3 },
    };
    expect(stackOrder(['right', 'bottom', 'left'], layout)).toEqual(['left', 'right', 'bottom']);
  });
});

describe('rowsNeeded', () => {
  it('reaches past the lowest panel so there is room to drag into', () => {
    const layout: RoomLayout = { a: { x: 0, y: 4, w: 3, h: 6 } };
    expect(rowsNeeded(layout)).toBeGreaterThan(10);
  });
});

describe('sameLayout', () => {
  const a: RoomLayout = { p: { x: 1, y: 2, w: 3, h: 4 } };

  it('is true for identical geometry', () => {
    expect(sameLayout(a, { p: { x: 1, y: 2, w: 3, h: 4 } })).toBe(true);
  });

  it('is false when a panel moved', () => {
    expect(sameLayout(a, { p: { x: 2, y: 2, w: 3, h: 4 } })).toBe(false);
  });

  it('is false when the panel set differs', () => {
    expect(sameLayout(a, { ...a, q: { x: 0, y: 0, w: 2, h: 2 } })).toBe(false);
  });
});
