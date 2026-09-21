import { describe, expect, it } from 'vitest';
import {
  CHAIN_LEAN_CAP,
  CHAIN_GLOW_FLOOR,
  chainGlow,
  chainLean,
  hoverRecession,
  threadPresence,
  threadTooCold,
} from './hoverLayers';

describe('hoverRecession', () => {
  it('leaves the hovered file own lines at full strength', () => {
    expect(hoverRecession(true, false)).toBe(1);
  });

  it('keeps the selection lines readable rather than withdrawing them', () => {
    // The whole point: a pinned table's other ropes must not fall to scenery
    // the moment she points at one of its files.
    const selection = hoverRecession(false, true);
    expect(selection).toBeGreaterThan(hoverRecession(false, false));
    expect(selection).toBeLessThan(1);
  });

  it('sends everything neither answer named to scenery', () => {
    expect(hoverRecession(false, false)).toBeCloseTo(0.22);
  });

  it('lets the hover answer win when a line is in both', () => {
    expect(hoverRecession(true, true)).toBe(1);
  });
});

describe('threadPresence', () => {
  it('is the old heat curve when nothing is hovered', () => {
    expect(threadPresence(0, false, false, false)).toBeCloseTo(0.16);
    expect(threadPresence(1, false, false, false)).toBeCloseTo(0.7);
  });

  it('ranks the three tiers under a hover', () => {
    const own = threadPresence(0.5, true, false, true);
    const selected = threadPresence(0.5, false, true, true);
    const outside = threadPresence(0.5, false, false, true);
    expect(own).toBeGreaterThan(selected);
    expect(selected).toBeGreaterThan(outside);
  });

  it('lifts a cold thread that is part of an answer', () => {
    // A pipe that has not moved in a month is still a pipe.
    expect(threadPresence(0, true, false, true)).toBe(threadPresence(1, true, false, true));
  });

  it('leaves a selection thread exactly where the hover found it', () => {
    // "i am ok with both showing" — the hover adds its own answer, it does
    // not repaint the selection's.
    for (const heat of [0, 0.3, 1]) {
      expect(threadPresence(heat, false, true, true)).toBe(
        threadPresence(heat, false, false, false),
      );
    }
  });
});

describe('threadTooCold', () => {
  it('drops an ice-cold thread nobody asked about', () => {
    expect(threadTooCold(0.01, false, false, false)).toBe(true);
  });

  it('never drops a thread the hover named, however cold', () => {
    expect(threadTooCold(0, true, false, true)).toBe(false);
  });

  it('culls a selection thread on the same floor it used before the hover', () => {
    // This is the regression the change exists to prevent: pinning a table and
    // hovering one of its files used to cull the selection's threads at the
    // hover floor (0.25), so threads that were plainly visible vanished.
    for (const heat of [0, 0.01, 0.1, 0.3]) {
      expect(threadTooCold(heat, false, true, true)).toBe(
        threadTooCold(heat, false, false, false),
      );
    }
  });

  it('culls harder under a hover than off it', () => {
    expect(threadTooCold(0.1, false, false, false)).toBe(false);
    expect(threadTooCold(0.1, false, false, true)).toBe(true);
  });
});

describe('chainLean', () => {
  it('never reaches the gold end, so a chain cannot read as a thread', () => {
    expect(chainLean(1)).toBe(CHAIN_LEAN_CAP);
    expect(chainLean(1)).toBeLessThan(1);
  });

  it('leaves a purely edited file fully ember', () => {
    expect(chainLean(0)).toBe(0);
  });

  it('keeps the lean monotonic, so the chain still warms with its file', () => {
    expect(chainLean(0.25)).toBeLessThan(chainLean(0.75));
  });

  it('clamps input that arrived outside 0..1', () => {
    expect(chainLean(-1)).toBe(0);
    expect(chainLean(4)).toBe(CHAIN_LEAN_CAP);
  });
});

describe('chainGlow', () => {
  it('lifts a stale file chain into view', () => {
    expect(chainGlow(0)).toBe(CHAIN_GLOW_FLOOR);
  });

  it('leaves a live file chain at its own strength', () => {
    expect(chainGlow(0.9)).toBeCloseTo(0.9);
  });

  it('never exceeds full glow', () => {
    expect(chainGlow(3)).toBe(1);
  });
});
