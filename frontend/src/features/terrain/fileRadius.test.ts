import { describe, expect, it } from 'vitest';
import { fileRadius } from './terrainCanvas';

// A file dot's radius comes from its size on disk, on a log scale, and has
// nothing to do with heat (terrainCanvas.ts fileRadius).
describe('fileRadius', () => {
  it('draws a tiny file, and one gone from disk, at the smallest dot', () => {
    expect([fileRadius(40), fileRadius(null)]).toEqual([4, 4]);
  });

  it('draws every file at the middle size when the payload has no sizes', () => {
    expect(fileRadius(undefined)).toBe(8.5);
  });

  it('caps a huge file at the biggest dot', () => {
    expect(fileRadius(50_000_000)).toBe(13);
  });

  it('adds the same step of radius for each tenfold jump in size', () => {
    const step1 = fileRadius(10_000) - fileRadius(1_000);
    const step2 = fileRadius(100_000) - fileRadius(10_000);
    expect(step1).toBeCloseTo(step2, 1);
  });
});
