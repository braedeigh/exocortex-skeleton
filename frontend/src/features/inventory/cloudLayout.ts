/**
 * Cloud view auto-layout — pure port of archivals.js's simplified
 * shelf-packing (itself from the inventory-app's CloudView.jsx): one box per
 * category sized by item count, boxes shelf-packed tallest-first
 * left-to-right/wrapped against the container's live width, items placed
 * row-major inside (first row reserved for the category header).
 */
import type { ArchivalItem } from './types';

export const ARCH_CELL_W = 50; // cloud grid cell — 48px thumb + 2px gap
export const ARCH_CELL_H = 58;
export const ARCH_THUMB_W = 48;
export const ARCH_THUMB_H = 56;

export interface BoxSize {
  w: number;
  h: number;
}

/** Box size in cells ~= inventory-app's calculateMinBoxSize. */
export function calcBoxSize(n: number): BoxSize {
  if (n <= 0) return { w: 2, h: 2 };
  const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.5)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { w: cols, h: rows + 1 }; // +1 row reserved for the category header
}

export interface PackedBox<T> {
  box: T;
  col: number;
  row: number;
}

export interface PackResult<T> {
  placed: PackedBox<T>[];
  totalRows: number;
}

/** Shelf packing: sort tallest first, fill a shelf left→right, wrap when a
 * box would overflow maxCols, shelf height = tallest box on that shelf. */
export function shelfPackBoxes<T extends BoxSize>(boxes: T[], maxCols: number): PackResult<T> {
  const sorted = [...boxes].sort((a, b) => b.h - a.h);
  let col = 0;
  let row = 0;
  let rowH = 0;
  const placed: PackedBox<T>[] = [];
  sorted.forEach((box) => {
    if (col > 0 && col + box.w > maxCols) {
      row += rowH;
      col = 0;
      rowH = 0;
    }
    placed.push({ box, col, row });
    col += box.w;
    rowH = Math.max(rowH, box.h);
  });
  const totalRows = placed.reduce((max, b) => Math.max(max, b.row + b.box.h), 0);
  return { placed, totalRows };
}

export interface CloudThumb {
  item: ArchivalItem;
  /** px offsets inside the box */
  x: number;
  y: number;
}

export interface CloudBox {
  category: string;
  label: string;
  /** px offsets inside the container */
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
  count: number;
  thumbs: CloudThumb[];
}

export interface CloudLayout {
  boxes: CloudBox[];
  heightPx: number;
}

/** Items (already filtered/sorted) + live container width → positioned boxes.
 * Categories are grouped A-Z with 'uncategorized' last, then repositioned by
 * the tallest-first shelf packing. */
export function buildCloudLayout(items: ArchivalItem[], containerWidth: number): CloudLayout {
  const groups = new Map<string, ArchivalItem[]>();
  items.forEach((item) => {
    const cat = (item.category || '').trim() || 'uncategorized';
    const list = groups.get(cat) || [];
    list.push(item);
    groups.set(cat, list);
  });
  const catNames = [...groups.keys()].sort((a, b) => {
    if (a === 'uncategorized') return 1;
    if (b === 'uncategorized') return -1;
    return a.localeCompare(b);
  });

  const width = containerWidth || 600;
  const maxCols = Math.max(4, Math.floor(width / ARCH_CELL_W));

  const boxes = catNames.map((cat) => {
    const catItems = groups.get(cat) || [];
    const size = calcBoxSize(catItems.length);
    return {
      name: cat,
      label: cat === 'uncategorized' ? 'Uncategorized' : cat,
      w: size.w,
      h: size.h,
      items: catItems,
    };
  });

  const { placed, totalRows } = shelfPackBoxes(boxes, maxCols);

  const outBoxes: CloudBox[] = placed.map(({ box, col, row }) => {
    const thumbs: CloudThumb[] = box.items.map((item, idx) => {
      const r = Math.floor(idx / box.w) + 1; // +1 skips the header row
      const c = idx % box.w;
      return { item, x: c * ARCH_CELL_W, y: r * ARCH_CELL_H };
    });
    return {
      category: box.name,
      label: box.label,
      x: col * ARCH_CELL_W,
      y: row * ARCH_CELL_H,
      widthPx: box.w * ARCH_CELL_W,
      heightPx: box.h * ARCH_CELL_H,
      count: box.items.length,
      thumbs,
    };
  });

  return { boxes: outBoxes, heightPx: totalRows * ARCH_CELL_H + 12 };
}
