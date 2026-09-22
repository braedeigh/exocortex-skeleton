import { describe, expect, it } from 'vitest';
import {
  SPIRAL_DOT_GAP,
  SPIRAL_INNER_RADIUS,
  SPIRAL_TURN_GAP,
  spiralSpots,
} from './spiralLayout';

/**
 * spiralLayout.test.ts — the coil a folder's dots are pinned to.
 *
 * Four things here would be invisible until they were badly wrong on screen,
 * so they're pinned: the dots are EVENLY spaced (the failure mode of a spiral
 * walked by angle instead of arc length is bunching at the centre, which
 * looks deliberate rather than broken); the arms hold their distance; the
 * radius grows with the square root of the count, which is the entire basis
 * of "it stays about the same size"; and widening the window is purely
 * additive, so dot 0 is in the same place whether the coil holds a month or
 * everything.
 */

/** Straight-line distance between two spots. */
function gapBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('spiralSpots', () => {
  it('spaces neighbouring dots evenly the whole way out', () => {
    const { spots } = spiralSpots(400);
    const gaps = spots.slice(1).map((spot, i) => gapBetween(spots[i], spot));
    // Measured 20.005 to 20.555 on a 633-dot coil: dead on the gap out in the
    // long arms, up to 3% over through the tight inner turns, where the
    // first-order angle step overshoots the arc slightly. A layout walked by
    // ANGLE instead fails this hard — its first gaps come out a fraction of
    // its last.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(SPIRAL_DOT_GAP * 0.99);
      expect(gap).toBeLessThan(SPIRAL_DOT_GAP * 1.03);
    }
  });

  it('holds one turn-gap between each arm and the next', () => {
    const { spots } = spiralSpots(300);
    // Two dots a full turn apart in angle should be exactly SPIRAL_TURN_GAP
    // further out — that's what makes the coil a regular mesh.
    for (const spot of spots) {
      const nextArm = spots.find((other) => other.angle >= spot.angle + 2 * Math.PI);
      if (!nextArm) break;
      const grown = nextArm.radius - spot.radius;
      expect(grown).toBeGreaterThan(SPIRAL_TURN_GAP * 0.99);
      expect(grown).toBeLessThan(SPIRAL_TURN_GAP * 1.2);
    }
  });

  it('keeps the centre hole clear', () => {
    const { spots } = spiralSpots(120);
    for (const spot of spots) {
      expect(Math.hypot(spot.x, spot.y)).toBeGreaterThanOrEqual(SPIRAL_INNER_RADIUS - 1e-9);
    }
  });

  it('grows with the square root of the count, not with the count', () => {
    // The promise the whole design rests on: six times the files is nowhere
    // near six times the coil.
    const month = spiralSpots(110).outerRadius;
    const everything = spiralSpots(633).outerRadius;
    expect(everything / month).toBeGreaterThan(2);
    expect(everything / month).toBeLessThan(3);
  });

  it('places dot i identically however many dots follow it', () => {
    // Why the newest sits at the centre: widening the window adds to the TIP,
    // so nothing she is already looking at moves.
    const month = spiralSpots(110);
    const everything = spiralSpots(633);
    for (let i = 0; i < month.spots.length; i += 1) {
      expect(everything.spots[i].x).toBeCloseTo(month.spots[i].x, 10);
      expect(everything.spots[i].y).toBeCloseTo(month.spots[i].y, 10);
    }
  });

  it('survives an empty and a single-dot coil', () => {
    expect(spiralSpots(0).spots).toEqual([]);
    expect(spiralSpots(0).outerRadius).toBe(SPIRAL_INNER_RADIUS);
    const one = spiralSpots(1);
    expect(one.spots).toHaveLength(1);
    expect(one.spots[0].radius).toBe(SPIRAL_INNER_RADIUS);
  });
});
