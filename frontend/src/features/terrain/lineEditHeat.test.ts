/**
 * lineEditHeat.test.ts — checks lineEditHeat.ts, how red one line of code is
 * by when it was last edited: fully red now, half at a third of the window,
 * nothing past the window's edge, and cold for a missing stamp or a bad
 * window.
 */
import { describe, expect, it } from 'vitest';
import { lineEditHeat } from './lineEditHeat';

const DAY = 86400;
const NOW = 1_800_000_000;

describe('lineEditHeat', () => {
  it('is fully red for a line edited right now', () => {
    expect(lineEditHeat(NOW, NOW, 7 * DAY)).toBe(1);
  });

  it('decays on the map curve: half a third of the way into the window', () => {
    // 7-day window → half-life of 7/3 days, so a line 7/3 days old is at 0.5.
    expect(lineEditHeat(NOW - (7 * DAY) / 3, NOW, 7 * DAY)).toBeCloseTo(0.5, 6);
  });

  it('is gone past the edge of the window, not merely faint', () => {
    expect(lineEditHeat(NOW - 7 * DAY - 1, NOW, 7 * DAY)).toBe(0);
    // Right AT the edge it's still the ramp's last sliver — an eighth (three
    // half-lives).
    expect(lineEditHeat(NOW - 7 * DAY, NOW, 7 * DAY)).toBeCloseTo(0.125, 6);
  });

  it('treats a missing stamp and a bad window as cold', () => {
    expect(lineEditHeat(null, NOW, 7 * DAY)).toBe(0);
    expect(lineEditHeat(0, NOW, 7 * DAY)).toBe(0);
    expect(lineEditHeat(NOW, NOW, 0)).toBe(0);
  });

  it('caps a future stamp (clock skew, an uncommitted line) at fully red', () => {
    expect(lineEditHeat(NOW + 60, NOW, DAY)).toBe(1);
  });
});
