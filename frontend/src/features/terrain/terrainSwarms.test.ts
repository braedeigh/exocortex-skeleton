import { describe, expect, it } from 'vitest';
import { swarmGroups, swarmHull, swarmNameAnchor } from './terrainSwarms';

describe('swarmGroups', () => {
  it('skips a swarm with no members', () => {
    const groups = swarmGroups([
      { id: 1, name: 'Empty', members: [] },
      { id: 2, name: 'Pair', members: [{ conv: 'a' }, { conv: 'b' }] },
    ]);
    expect(groups).toEqual([{ id: 2, name: 'Pair', memberIds: ['a', 'b'] }]);
  });
});

describe('swarmHull', () => {
  it('is empty with no orbs', () => {
    expect(swarmHull([], 10)).toEqual([]);
  });

  it('wraps a single orb in a circle padding wider than it', () => {
    const hull = swarmHull([{ x: 0, y: 0, radius: 5 }], 10);
    for (const p of hull) expect(Math.hypot(p.x, p.y)).toBeCloseTo(15);
  });

  it('keeps every orb, with its padding, inside the outline', () => {
    const orbs = [
      { x: 0, y: 0, radius: 6 },
      { x: 120, y: 30, radius: 8 },
      { x: 60, y: -80, radius: 4 },
      { x: 50, y: 0, radius: 3 }, // inside the triangle the others make
    ];
    const hull = swarmHull(orbs, 12);
    // Convex, counter-clockwise: every orb centre lies left of every edge,
    // at least radius + most-of-padding away (the rim points are a polygon,
    // so the true distance dips a little between them).
    for (const orb of orbs) {
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const edge = Math.hypot(b.x - a.x, b.y - a.y);
        const side = ((b.x - a.x) * (orb.y - a.y) - (b.y - a.y) * (orb.x - a.x)) / edge;
        expect(side).toBeGreaterThan(orb.radius + 11);
      }
    }
  });
});

describe('swarmNameAnchor', () => {
  it('sits centred over the outline at its top', () => {
    const hull = swarmHull([{ x: 0, y: 0, radius: 0 }, { x: 100, y: 0, radius: 0 }], 10);
    const anchor = swarmNameAnchor(hull)!;
    expect(anchor.x).toBeCloseTo(50);
    expect(anchor.y).toBeCloseTo(-10);
  });

  it('is null for an empty outline', () => {
    expect(swarmNameAnchor([])).toBeNull();
  });
});
