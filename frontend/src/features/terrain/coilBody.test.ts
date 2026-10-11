import { forceCollide, forceSimulation, type SimulationNodeDatum } from 'd3-force';
import { describe, expect, it } from 'vitest';
import { NODE_GAP, bodyRadius, coilBodyRadius, collideRadius } from './ringBodies';
import { spiralSpots } from './spiralLayout';

// A coil's folder holds the ground for the whole spiral, and the dots on it
// hold none of their own (ringBodies.ts coilBodyRadius, collideRadius).

interface Body extends SimulationNodeDatum {
  r: number;
  onCoil: boolean;
}

/** Run a lone coil through the collider the way terrainCanvas.ts does — dots
 * pinned to their spots around the folder every tick — and say how far the
 * folder travelled. */
function hubDrift(radiusFor: (body: Body) => number): number {
  const dotBody = bodyRadius(12, false);
  const arrangement = spiralSpots(100);
  const hub: Body = { x: 0, y: 0, r: coilBodyRadius(arrangement.outerRadius, [dotBody]), onCoil: false };
  const dots: Body[] = arrangement.spots.map((s) => ({ fx: s.x, fy: s.y, r: dotBody, onCoil: true }));
  const sim = forceSimulation<Body>([hub, ...dots])
    .force('collide', forceCollide<Body>(radiusFor))
    .stop();
  for (let tick = 0; tick < 300; tick += 1) {
    sim.tick();
    arrangement.spots.forEach((s, i) => {
      dots[i].fx = (hub.x ?? 0) + s.x;
      dots[i].fy = (hub.y ?? 0) + s.y;
    });
  }
  return Math.hypot(hub.x ?? 0, hub.y ?? 0);
}

describe('a coil in the collider', () => {
  it('stays where it is when nothing else pushes on it', () => {
    expect(hubDrift((b) => collideRadius(b.r, b.onCoil))).toBeLessThan(1);
  });

  it('walks off if its dots keep bodies of their own (the bug this guards)', () => {
    expect(hubDrift((b) => b.r)).toBeGreaterThan(50);
  });

  it('reaches past the outermost dot centre by that dot’s body', () => {
    expect(coilBodyRadius(100, [8, 17])).toBe(117);
    expect(coilBodyRadius(100, [])).toBe(100 + NODE_GAP);
  });
});
