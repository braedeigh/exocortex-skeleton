import { describe, expect, it } from 'vitest';
import {
  ARCH_CELL_H,
  ARCH_CELL_W,
  buildCloudLayout,
  calcBoxSize,
  shelfPackBoxes,
} from './cloudLayout';
import type { ArchivalItem } from './types';

describe('calcBoxSize', () => {
  it('has a 2x2 floor for empty categories', () => {
    expect(calcBoxSize(0)).toEqual({ w: 2, h: 2 });
  });
  it('reserves a header row (+1) above the item rows', () => {
    // 1 item: cols = max(2, ceil(sqrt(1.5))) = 2, rows = 1 → h = 2
    expect(calcBoxSize(1)).toEqual({ w: 2, h: 2 });
  });
  it('grows roughly with sqrt(n * 1.5)', () => {
    // 6 items: cols = ceil(sqrt(9)) = 3, rows = 2 → h = 3
    expect(calcBoxSize(6)).toEqual({ w: 3, h: 3 });
    // 12 items: cols = ceil(sqrt(18)) = 5, rows = 3 → h = 4
    expect(calcBoxSize(12)).toEqual({ w: 5, h: 4 });
  });
});

describe('shelfPackBoxes', () => {
  it('packs tallest-first on one shelf when they fit', () => {
    const { placed, totalRows } = shelfPackBoxes(
      [
        { name: 'short', w: 2, h: 2 },
        { name: 'tall', w: 2, h: 4 },
      ],
      10,
    );
    expect(placed[0].box.name).toBe('tall');
    expect(placed[0]).toMatchObject({ col: 0, row: 0 });
    expect(placed[1]).toMatchObject({ col: 2, row: 0 });
    expect(totalRows).toBe(4);
  });
  it('wraps to a new shelf when a box would overflow maxCols', () => {
    const { placed, totalRows } = shelfPackBoxes(
      [
        { name: 'a', w: 3, h: 3 },
        { name: 'b', w: 3, h: 2 },
      ],
      4,
    );
    expect(placed[0]).toMatchObject({ col: 0, row: 0 });
    // b (w=3) doesn't fit next to a (3+3 > 4) → next shelf at row 3
    expect(placed[1]).toMatchObject({ col: 0, row: 3 });
    expect(totalRows).toBe(5);
  });
  it('a box wider than maxCols still lands at col 0 (old behavior)', () => {
    const { placed } = shelfPackBoxes([{ name: 'wide', w: 8, h: 2 }], 4);
    expect(placed[0]).toMatchObject({ col: 0, row: 0 });
  });
});

function mkItems(cat: string, n: number): ArchivalItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${cat}-${i}`, name: `${cat} ${i}`, category: cat }));
}

describe('buildCloudLayout', () => {
  it('groups by category with uncategorized last in group order', () => {
    const layout = buildCloudLayout(
      [...mkItems('zeta', 1), { id: 'u', name: 'thing' }, ...mkItems('alpha', 1)],
      600,
    );
    const cats = layout.boxes.map((b) => b.category);
    // all same height → shelf packing keeps the grouped (alpha, zeta, uncategorized) order
    expect(cats).toEqual(['alpha', 'zeta', 'uncategorized']);
    expect(layout.boxes[2].label).toBe('Uncategorized');
  });

  it('places thumbs row-major below the header row', () => {
    const layout = buildCloudLayout(mkItems('c', 3), 600);
    const box = layout.boxes[0];
    // 3 items → w=3 (ceil(sqrt(4.5))=3): all on the row below the header
    expect(box.thumbs.map((t) => ({ x: t.x, y: t.y }))).toEqual([
      { x: 0, y: ARCH_CELL_H },
      { x: ARCH_CELL_W, y: ARCH_CELL_H },
      { x: 2 * ARCH_CELL_W, y: ARCH_CELL_H },
    ]);
  });

  it('sizes boxes and the container in px from the cell grid', () => {
    const layout = buildCloudLayout(mkItems('c', 3), 600);
    const box = layout.boxes[0];
    expect(box.widthPx).toBe(3 * ARCH_CELL_W);
    expect(box.heightPx).toBe(2 * ARCH_CELL_H);
    expect(layout.heightPx).toBe(2 * ARCH_CELL_H + 12);
  });

  it('respects the container width when packing (narrow wraps shelves)', () => {
    const items = [...mkItems('a', 6), ...mkItems('b', 6)]; // two 3-wide boxes
    const wide = buildCloudLayout(items, 600); // maxCols 12 — one shelf
    const narrow = buildCloudLayout(items, 220); // maxCols max(4, 4) — wraps
    expect(wide.heightPx).toBeLessThan(narrow.heightPx);
  });

  it('falls back to a 600px-equivalent grid when width is 0 (unmeasured)', () => {
    const a = buildCloudLayout(mkItems('a', 4), 0);
    const b = buildCloudLayout(mkItems('a', 4), 600);
    expect(a.heightPx).toBe(b.heightPx);
  });
});
