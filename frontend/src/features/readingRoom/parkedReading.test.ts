/**
 * parkedReading — the parked-reading clause's arithmetic: the dwell gate,
 * page-turn geometry (frontier to the top, advance a screen), flip pacing,
 * and the end-of-turn settle.
 */
import { describe, expect, it } from 'vitest';
import { PARK_DWELL_MS, PARK_FLIP_MS, isAtBottom, parkStep, shouldArm } from './parkedReading';

const view = (scrollTop: number, scrollHeight: number, clientHeight = 800) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('shouldArm', () => {
  it('arms only after the full dwell at the bottom, and only while writing', () => {
    const t0 = 1000;
    expect(shouldArm(null, true, t0 + PARK_DWELL_MS)).toBe(false);
    expect(shouldArm(t0, true, t0 + PARK_DWELL_MS - 1)).toBe(false);
    expect(shouldArm(t0, true, t0 + PARK_DWELL_MS)).toBe(true);
    // waiting at the bottom of a finished reply is just reading, not parking
    expect(shouldArm(t0, false, t0 + PARK_DWELL_MS)).toBe(false);
  });
});

describe('isAtBottom', () => {
  it('tolerates the epsilon but not a real scroll-away', () => {
    expect(isAtBottom(view(1200, 2000))).toBe(true); // exactly at the bottom
    expect(isAtBottom(view(1180, 2000))).toBe(true); // within tolerance
    expect(isAtBottom(view(900, 2000))).toBe(false);
  });
});

describe('parkStep', () => {
  it('waits while less than a screen of unread text has pooled', () => {
    // frontier 800, content 1200: 400px unread < 800px screen
    expect(parkStep(view(0, 1200), 800, 0, true, 60_000).kind).toBe('wait');
  });

  it('turns the page once a screenful pools: frontier to the top, advance a screen', () => {
    const act = parkStep(view(0, 1700), 800, 0, true, 60_000);
    expect(act).toEqual({ kind: 'flip', to: 800, frontier: 1600 });
  });

  it('paces flips so a fast stream cannot outrun her eyes', () => {
    const flippedAt = 60_000;
    expect(parkStep(view(800, 2600), 1600, flippedAt, true, flippedAt + PARK_FLIP_MS - 1).kind).toBe('wait');
    expect(parkStep(view(800, 2600), 1600, flippedAt, true, flippedAt + PARK_FLIP_MS).kind).toBe('flip');
  });

  it('keeps draining a backlog after the turn ends', () => {
    expect(parkStep(view(0, 1700), 800, 0, false, 60_000).kind).toBe('flip');
  });

  it('reveals the partial tail once the turn is over, then stands down', () => {
    const act = parkStep(view(800, 2000), 1600, 0, false, 60_000);
    expect(act).toEqual({ kind: 'reveal', to: 2000 });
    expect(parkStep(view(1200, 2000), 2000, 0, false, 60_000).kind).toBe('disarm');
  });
});
