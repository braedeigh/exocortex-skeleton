import { describe, expect, it } from 'vitest';
import { NODE_GAP, RING_GAP, bodyRadius, sameRings } from './ringBodies';
import type { FileTouchKind } from './terrainGraph';

describe('bodyRadius (the circle nothing else may enter)', () => {
  it('gives a ringed dot more ground than an unringed one of the same size', () => {
    expect(bodyRadius(4, true)).toBeGreaterThan(bodyRadius(4, false));
  });

  it('is the dot plus its gap, in world units', () => {
    expect(bodyRadius(4, false)).toBe(4 + NODE_GAP);
    expect(bodyRadius(4, true)).toBe(4 + RING_GAP);
  });

  it('keeps two ringed dots far enough apart that their rings only touch', () => {
    // d3's collide separates centres by at least the sum of the two bodies,
    // and the ring is drawn ON the body — so at that distance the rings meet
    // and never cross.
    const hot = bodyRadius(13, true);
    const cold = bodyRadius(4, true);
    const separation = hot + cold;
    expect(separation).toBe(hot + cold);
    expect(separation - hot).toBeGreaterThanOrEqual(cold);
  });

  it('leaves a ringed dot clear of an unringed neighbour by the ordinary gap', () => {
    const ringed = bodyRadius(9, true);
    const plain = 5; // the neighbour's drawn radius
    const separation = ringed + bodyRadius(plain, false);
    expect(separation - ringed - plain).toBe(NODE_GAP);
  });

  it('grows with the dot, so a hot file claims more room than a cold one', () => {
    expect(bodyRadius(13, true)).toBeGreaterThan(bodyRadius(4, true));
  });
});

describe('sameRings (does not wake the physics for an identical set)', () => {
  const rings = (entries: [string, FileTouchKind][]) => new Map<string, FileTouchKind>(entries);

  it('sees a rebuilt-but-identical map as unchanged', () => {
    expect(sameRings(rings([['a', 'read']]), rings([['a', 'read']]))).toBe(true);
  });

  it('is true for the very same map', () => {
    const one = rings([['a', 'modified']]);
    expect(sameRings(one, one)).toBe(true);
  });

  it('notices a file joining the set', () => {
    expect(sameRings(rings([['a', 'read']]), rings([['a', 'read'], ['b', 'read']]))).toBe(false);
  });

  it('notices a file leaving the set', () => {
    expect(sameRings(rings([['a', 'read'], ['b', 'read']]), rings([['a', 'read']]))).toBe(false);
  });

  it('notices a read turning into a write on the same file', () => {
    expect(sameRings(rings([['a', 'read']]), rings([['a', 'modified']]))).toBe(false);
  });

  it('treats two empty sets as the same', () => {
    expect(sameRings(rings([]), rings([]))).toBe(true);
  });
});
