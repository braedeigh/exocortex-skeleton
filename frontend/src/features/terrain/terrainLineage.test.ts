import { describe, expect, it } from 'vitest';
import { lineageArrow, lineageLinks } from './terrainLineage';

/** The spinoff arrows' pure part: which pairs, and where the arrow starts,
 * ends and points. */
describe('lineageLinks', () => {
  it('pairs each spun-off session with its parent and skips the rest', () => {
    expect(
      lineageLinks([
        { id: 'child', spawned_from: 'parent' },
        { id: 'parent' },
        { id: 'loop', spawned_from: 'loop' },
      ]),
    ).toEqual([{ parentId: 'parent', childId: 'child' }]);
  });
});

describe('lineageArrow', () => {
  it('starts at the parent rim and ends at the child rim', () => {
    const arrow = lineageArrow({ x: 0, y: 0 }, 10, { x: 100, y: 0 }, 10)!;
    expect(Math.hypot(arrow.start.x, arrow.start.y)).toBeCloseTo(10);
    expect(Math.hypot(arrow.end.x - 100, arrow.end.y)).toBeCloseTo(10);
  });

  it('points toward the child', () => {
    const arrow = lineageArrow({ x: 0, y: 0 }, 5, { x: 100, y: 0 }, 5)!;
    expect(arrow.middleDirection.x).toBeGreaterThan(0.99);
    expect(arrow.endDirection.x).toBeGreaterThan(0);
  });

  it('draws nothing when the orbs overlap', () => {
    expect(lineageArrow({ x: 0, y: 0 }, 10, { x: 12, y: 0 }, 10)).toBeNull();
  });
});
