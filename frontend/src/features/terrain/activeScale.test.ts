import { describe, expect, it } from 'vitest';
import { POS_STEPS } from './TerrainDials';
import {
  ACTIVE_ANCHOR_SECONDS,
  ACTIVE_MAX_SECONDS,
  ACTIVE_MIN_SECONDS,
  ACTIVE_TICK_SECONDS,
  activePct,
  posFromSeconds,
  secondsFromPos,
} from './activeScale';

/**
 * activeScale.test.ts — the Active bar's axis (activeScale.ts). The load-
 * bearing claim is the shape of the track: minutes have to be aimable at the
 * left end, and the day-to-week stretch has to be squeezed into the tail
 * rather than eating half the travel.
 */

const HOUR = 3600;
const DAY = 86400;

describe('the Active axis', () => {
  it('pins both ends exactly', () => {
    expect(secondsFromPos(posFromSeconds(ACTIVE_MIN_SECONDS))).toBe(ACTIVE_MIN_SECONDS);
    expect(secondsFromPos(posFromSeconds(ACTIVE_MAX_SECONDS))).toBe(ACTIVE_MAX_SECONDS);
    expect(activePct(ACTIVE_MIN_SECONDS)).toBeCloseTo(0);
    expect(activePct(ACTIVE_MAX_SECONDS)).toBeCloseTo(100);
  });

  it('puts one day about three quarters along, so the week folds into the tail', () => {
    // The whole reason this axis exists: a day is the interesting end, and
    // everything past it is compressed rather than given equal track.
    expect(activePct(DAY)).toBeGreaterThan(70);
    expect(activePct(DAY)).toBeLessThan(78);
  });

  it('gives minutes real travel — the first hour is most of the first third', () => {
    // On a linear 5m..7d track, one hour would live in the first 0.5%.
    expect(activePct(HOUR)).toBeGreaterThan(25);
  });

  it('is monotone — sliding right never goes back', () => {
    let prev = -1;
    for (let pos = 0; pos <= POS_STEPS; pos += 25) {
      const seconds = secondsFromPos(pos);
      expect(seconds).toBeGreaterThanOrEqual(prev);
      prev = seconds;
    }
  });

  it('round-trips a window closely enough that the readout does not lie', () => {
    // A log track quantizes in *relative* steps, so an exact integer
    // round-trip isn't achievable — landing within a half-percent is what
    // matters, because formatAge rounds to the nearest minute/hour/day anyway.
    for (const seconds of [300, 900, HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY]) {
      const back = secondsFromPos(posFromSeconds(seconds));
      expect(Math.abs(back - seconds)).toBeLessThanOrEqual(Math.max(1, seconds * 0.005));
    }
  });

  it('clamps rather than running off either end', () => {
    expect(secondsFromPos(posFromSeconds(1))).toBe(ACTIVE_MIN_SECONDS);
    expect(secondsFromPos(posFromSeconds(365 * DAY))).toBe(ACTIVE_MAX_SECONDS);
  });
});

describe('the ruler', () => {
  it('stays inside the track, ends included', () => {
    for (const tick of ACTIVE_TICK_SECONDS) {
      expect(tick).toBeGreaterThanOrEqual(ACTIVE_MIN_SECONDS);
      expect(tick).toBeLessThanOrEqual(ACTIVE_MAX_SECONDS);
    }
  });

  it('marks no tick twice — the day is an hour tick, not also a day tick', () => {
    expect(new Set(ACTIVE_TICK_SECONDS).size).toBe(ACTIVE_TICK_SECONDS.length);
  });

  it('carries every anchor, so the hour, the day and the week are findable', () => {
    for (const anchor of ACTIVE_ANCHOR_SECONDS) {
      expect(ACTIVE_TICK_SECONDS).toContain(anchor);
    }
  });
});
