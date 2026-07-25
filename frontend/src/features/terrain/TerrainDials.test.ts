import { describe, expect, it } from 'vitest';
import { formatDay, posFromValue, startOfLocalDay, valueFromPos } from './TerrainDials';

/** The dials' pure math. The log mapping is the load-bearing part: it's what
 * makes the low end of a 1..3260 range aimable with a thumb. */

describe('log slider mapping', () => {
  const MIN = 1;
  const MAX = 3260;

  it('pins both ends exactly', () => {
    expect(valueFromPos(posFromValue(MIN, MIN, MAX), MIN, MAX)).toBe(MIN);
    expect(valueFromPos(posFromValue(MAX, MIN, MAX), MIN, MAX)).toBe(MAX);
  });

  it('round-trips values to within a file or two', () => {
    // A log track quantizes in *relative* steps, so an exact integer
    // round-trip isn't achievable at the top of the range — landing within
    // ~0.5% is what actually matters, since the readout reports the drawn
    // count rather than the requested one.
    for (const v of [1, 5, 50, 350, 700, 1500, 3000, 3260]) {
      const back = valueFromPos(posFromValue(v, MIN, MAX), MIN, MAX);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(1, v * 0.005));
    }
  });

  it('is monotone — sliding right never goes back', () => {
    let prev = -1;
    for (let pos = 0; pos <= 10000; pos += 25) {
      const v = valueFromPos(pos, MIN, MAX);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('gives the small end real travel — half the track is under ~100 files', () => {
    // The whole point of the log scale: on a linear slider, "show me 50
    // files" would live in the first 1.5% of the track.
    const mid = valueFromPos(5000, MIN, MAX);
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(100);
  });

  it('clamps out-of-range values instead of producing NaN positions', () => {
    expect(posFromValue(0, MIN, MAX)).toBe(0);
    expect(posFromValue(99999, MIN, MAX)).toBe(10000);
  });

  it('degenerate ranges do not blow up', () => {
    expect(posFromValue(1, 1, 1)).toBe(0);
    expect(valueFromPos(5000, 1, 1)).toBe(1);
  });
});

describe('local day snapping', () => {
  it('snaps to local midnight, not UTC midnight', () => {
    const noon = new Date(2026, 6, 10, 12, 0, 0);        // Jul 10, local noon
    const start = startOfLocalDay(noon.getTime() / 1000);
    const back = new Date(start * 1000);
    expect(back.getHours()).toBe(0);
    expect(back.getDate()).toBe(10);
  });

  it('a whole local day round-trips to the same calendar date', () => {
    // The bug this guards: with UTC snapping, any timezone behind UTC shows
    // a handle labeled with the *previous* day.
    for (const hour of [0, 1, 6, 12, 19, 23]) {
      const t = new Date(2026, 6, 10, hour, 30, 0).getTime() / 1000;
      expect(formatDay(startOfLocalDay(t), t)).toBe(formatDay(t, t));
    }
  });

  it('the end of a day is still that same day', () => {
    const t = new Date(2026, 6, 10, 9, 0, 0).getTime() / 1000;
    const endOfDay = startOfLocalDay(t) + 86400 - 1;
    expect(new Date(endOfDay * 1000).getDate()).toBe(10);
  });
});

describe('formatDay', () => {
  it('omits the year for the current year and includes it otherwise', () => {
    const thisYear = new Date(2026, 6, 10).getTime() / 1000;
    const lastYear = new Date(2025, 6, 10).getTime() / 1000;
    expect(formatDay(thisYear, thisYear)).not.toMatch(/2026/);
    expect(formatDay(lastYear, thisYear)).toMatch(/2025/);
  });
});
