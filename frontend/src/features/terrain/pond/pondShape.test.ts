import { describe, expect, it } from 'vitest';
import { bucketShape, shapePath, type ShapeDay } from './pondShape';

const day = (d: string, cards: number, owner = cards): ShapeDay => ({ day: d, cards, owner });

describe('bucketShape', () => {
  it('is empty for an empty pond rather than throwing', () => {
    expect(bucketShape([], 10)).toEqual([]);
    expect(bucketShape([day('2026-07-06', 3)], 0)).toEqual([]);
  });

  it('never makes more columns than there are days', () => {
    // The crude drawing asks for 12 columns; a two-day-old pond has two.
    expect(bucketShape([day('a', 1), day('b', 2)], 12)).toHaveLength(2);
  });

  it('normalises heights against the busiest bucket', () => {
    const cols = bucketShape([day('a', 1), day('b', 10), day('c', 5)], 3);
    expect(cols.map((c) => c.height)).toEqual([0.1, 1, 0.5]);
  });

  it('covers every day exactly once when it merges them', () => {
    const days = Array.from({ length: 10 }, (_, i) => day(`d${i}`, i + 1));
    const cols = bucketShape(days, 4);
    // 1..10 sums to 55 — no day dropped, none counted twice.
    expect(cols.reduce((s, c) => s + c.cards, 0)).toBe(55);
  });

  it('carries her share of each bucket, not a raw count', () => {
    const cols = bucketShape([day('a', 10, 4)], 1);
    expect(cols[0].ownShare).toBeCloseTo(0.4);
  });

  it('reports a zero-height, zero-share bucket without dividing by zero', () => {
    const cols = bucketShape([day('a', 0, 0)], 1);
    expect(cols[0]).toEqual({ height: 0, ownShare: 0, cards: 0 });
  });

  it('gives the same total at every level of detail — one pond, two drawings', () => {
    const days = Array.from({ length: 40 }, (_, i) => day(`d${i}`, (i % 7) + 1));
    const crude = bucketShape(days, 10).reduce((s, c) => s + c.cards, 0);
    const fine = bucketShape(days, 40).reduce((s, c) => s + c.cards, 0);
    expect(crude).toBe(fine);
  });
});

describe('shapePath', () => {
  it('is empty for no columns', () => {
    expect(shapePath([], 100, 50)).toBe('');
  });

  it('closes the body along the bed so it fills as water', () => {
    const path = shapePath(bucketShape([day('a', 1), day('b', 2)], 2), 100, 50);
    expect(path.startsWith('M 0 50.0')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect(path).toContain('L 100.0 50.0');
  });

  it('keeps water in the pond on its quietest day', () => {
    // A flat-zero run must still draw a body, not a straight line on the bed.
    const path = shapePath(bucketShape([day('a', 0), day('b', 0)], 2), 100, 50);
    expect(path).toContain('44.0'); // 50 - 50 * 0.12
  });

  it('never lets the busiest day touch the ceiling', () => {
    const path = shapePath(bucketShape([day('a', 10)], 1), 100, 50);
    // 50 - 50 * 0.9 = 5, so nothing is ever at y=0.
    expect(path).toContain('5.0');
    expect(path).not.toContain(' 0.0 ');
  });
});
