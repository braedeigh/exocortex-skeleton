import { describe, expect, it } from 'vitest';
import { laneSideX, nearestExit, placeOrbNames, spreadOrbs, type NameAsk } from './agentLayout';

const zone = { left: 0, top: 0, right: 400, bottom: 200 };

describe('laneSideX', () => {
  it('puts Coding on the left and Personal on the right, whichever order the repos come in', () => {
    for (const anchors of [[200, 900], [900, 200], [900, 550, 200]]) {
      expect(laneSideX('coding', anchors)).toBe(200);
      expect(laneSideX('personal', anchors)).toBe(900);
    }
  });

  it('gives every other room no side', () => {
    for (const lane of ['orchestra', 'research', 'linear', '']) {
      expect(laneSideX(lane, [200, 900])).toBeNull();
    }
  });

  it('gives nobody a side on a map with one repo', () => {
    expect(laneSideX('coding', [500])).toBeNull();
    expect(laneSideX('personal', [])).toBeNull();
  });
});

describe('nearestExit', () => {
  it('leaves an orb outside the fence alone', () => {
    expect(nearestExit(-10, 50, zone)).toBeNull();
    expect(nearestExit(200, 250, zone)).toBeNull();
  });

  it('moves an orb in the middle of the shelves out through the nearest edge', () => {
    // 40 from the top, 160 from the bottom, 200 from either side.
    expect(nearestExit(200, 40, zone)).toEqual({ x: 200, y: 0 });
  });

  it('exits sideways when a side is nearer than top or bottom', () => {
    expect(nearestExit(390, 100, zone)).toEqual({ x: 400, y: 100 });
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
