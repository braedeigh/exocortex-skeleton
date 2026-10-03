import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  laneSide,
  outsideSpot,
  placeOrbNames,
  spreadOrbs,
  type NameAsk,
  type OrbSide,
} from './agentLayout';

const zone = { left: 0, top: 0, right: 400, bottom: 200 };

describe('laneSide', () => {
  it('puts Coding on the left and Personal on the right', () => {
    expect(laneSide('coding', 2)).toBe('left');
    expect(laneSide('personal', 3)).toBe('right');
  });

  it('gives every other room no side', () => {
    for (const lane of ['orchestra', 'research', 'linear', '']) {
      expect(laneSide(lane, 2)).toBeNull();
    }
  });

  it('gives nobody a side on a map with one repo', () => {
    expect(laneSide('coding', 1)).toBeNull();
    expect(laneSide('personal', 0)).toBeNull();
  });
});

describe('orbs outside the cloud', () => {
  // A cloud of file dots, measured the way the map measures it.
  const dots = [
    { x: 0, y: 0, radius: 10 },
    { x: 400, y: 300, radius: 10 },
    { x: 800, y: -100, radius: 20 },
  ];
  const cloud = boundsOf(dots)!;
  const gap = 130;

  it('measures the cloud round every dot and every box joined on', () => {
    expect(cloud).toEqual({ left: -10, top: -120, right: 820, bottom: 310 });
    expect(boundsOf([], [zone])).toEqual(zone);
    expect(boundsOf([])).toBeNull();
  });

  it('leaves an orb already outside the ring alone, whatever its side', () => {
    expect(outsideSpot(400, 600, null, cloud, gap)).toBeNull();
    // A Coding orb above the cloud is allowed to be there: the side is a preference.
    expect(outsideSpot(400, -500, 'left', cloud, gap)).toBeNull();
  });

  it('sends an orb out through the nearest edge, gap included', () => {
    expect(outsideSpot(400, 290, null, cloud, gap)).toEqual({ x: 400, y: 440 });
    expect(outsideSpot(800, 100, null, cloud, gap)).toEqual({ x: 950, y: 100 });
  });

  it('prefers the room side from deep inside, but not for an orb that just crossed another edge', () => {
    // Mid-cloud: the bottom edge is nearest (340 away against 545 to either
    // side), but an orb's own side counts as half as far.
    expect(outsideSpot(405, 100, null, cloud, gap)).toEqual({ x: 405, y: 440 });
    expect(outsideSpot(405, 100, 'left', cloud, gap)).toEqual({ x: -140, y: 100 });
    expect(outsideSpot(405, 100, 'right', cloud, gap)).toEqual({ x: 950, y: 100 });
    // Just inside the top edge: back to the top edge, not flung to the side.
    expect(outsideSpot(405, -240, 'left', cloud, gap)).toEqual({ x: 405, y: -250 });
  });

  it('settles a dozen agents working on the same files outside, leaning to their sides, without stacking', () => {
    // The map's own loop in miniature: every orb is pulled toward the same
    // spot in the middle of the cloud and, more softly, toward its room's
    // side; pushed off its neighbours; then fenced.
    const home = { x: 400, y: 100 };
    const middle = (cloud.left + cloud.right) / 2;
    const sides: OrbSide[] = ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', null, null, null];
    const orbs = sides.map((side, i) => ({ side, x: home.x + i, y: home.y - i, vx: 0, vy: 0 }));
    for (let tick = 0; tick < 400; tick++) {
      const alpha = Math.max(0.001, 0.98 ** tick);
      for (const orb of orbs) {
        orb.vx += (home.x - orb.x) * 0.05 * alpha;
        orb.vy += (home.y - orb.y) * 0.05 * alpha;
        if (orb.side === 'left') orb.vx += (cloud.left - gap - orb.x) * 0.03 * alpha;
        if (orb.side === 'right') orb.vx += (cloud.right + gap - orb.x) * 0.03 * alpha;
      }
      spreadOrbs(orbs, gap, 0.6);
      for (const orb of orbs) {
        orb.vx *= 0.6;
        orb.vy *= 0.6;
        orb.x += orb.vx;
        orb.y += orb.vy;
        const spot = outsideSpot(orb.x, orb.y, orb.side, cloud, gap);
        if (spot) Object.assign(orb, spot);
      }
    }
    for (const orb of orbs) {
      expect(outsideSpot(orb.x, orb.y, orb.side, cloud, gap)).toBeNull();
      if (orb.side === 'left') expect(orb.x).toBeLessThan(middle);
      if (orb.side === 'right') expect(orb.x).toBeGreaterThan(middle);
    }
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        expect(Math.hypot(orbs[i].x - orbs[j].x, orbs[i].y - orbs[j].y)).toBeGreaterThan(gap * 0.8);
      }
    }
  });
});

describe('spreadOrbs', () => {
  it('pushes two orbs closer than the gap apart', () => {
    const a = { x: 0, y: 0, vx: 0, vy: 0 };
    const b = { x: 10, y: 0, vx: 0, vy: 0 };
    spreadOrbs([a, b], 100, 1);
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
  });

  it('leaves orbs already further apart than the gap untouched', () => {
    const a = { x: 0, y: 0, vx: 0, vy: 0 };
    const b = { x: 150, y: 0, vx: 0, vy: 0 };
    spreadOrbs([a, b], 100, 1);
    expect([a.vx, b.vx]).toEqual([0, 0]);
  });

  it('splits two orbs sitting on the exact same spot', () => {
    const a = { x: 5, y: 5, vx: 0, vy: 0 };
    const b = { x: 5, y: 5, vx: 0, vy: 0 };
    spreadOrbs([a, b], 100, 1);
    expect(Number.isFinite(a.vx) && a.vx !== b.vx).toBe(true);
  });
});

const ask = (id: string, x: number, y: number): NameAsk => ({ id, x, y, radius: 9, width: 120, height: 16 });

describe('placeOrbNames', () => {
  it('puts a lone name above its orb', () => {
    expect(placeOrbNames([ask('a', 300, 300)]).get('a')?.side).toBe('above');
  });

  it('moves the second of two side-by-side names off the first', () => {
    // Side by side, their names would land on top of each other above them.
    const placed = placeOrbNames([ask('a', 300, 300), ask('b', 340, 300)]);
    expect(placed.get('a')?.side).toBe('above');
    expect(placed.get('b')?.side).not.toBe('above');
  });

  it('gives the first ask its preferred spot, so the hovered orb is never the one moved', () => {
    const placed = placeOrbNames([ask('b', 340, 300), ask('a', 300, 300)]);
    expect(placed.get('b')?.side).toBe('above');
  });

  it('never drops a name, even when every spot is covered', () => {
    const crowd = [ask('a', 300, 300), ask('b', 300, 300), ask('c', 300, 300), ask('d', 300, 300), ask('e', 300, 300)];
    expect(placeOrbNames(crowd).size).toBe(5);
  });
});
