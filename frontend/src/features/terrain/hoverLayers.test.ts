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
  it('paints nothing for a thread nobody asked about', () => {
    // The whole point of the change: at rest the threads are off the map.
    expect(threadPresence(0, false, false)).toBe(0);
    expect(threadPresence(1, false, false)).toBe(0);
  });

  it('brings the hovered dot own threads to the front', () => {
    expect(threadPresence(0.5, true, false)).toBeGreaterThan(
      threadPresence(0.5, false, true),
    );
  });

  it('keeps a standing thread on the old heat curve', () => {
    // A pinned table, a spotlit agent, or a replay path — drawn with no
    // cursor on them, at exactly the presence they always had.
    expect(threadPresence(0, false, true)).toBeCloseTo(0.16);
    expect(threadPresence(1, false, true)).toBeCloseTo(0.7);
  });

  it('lifts a cold thread that is part of an answer', () => {
    // A pipe that has not moved in a month is still a pipe.
    expect(threadPresence(0, true, false)).toBe(threadPresence(1, true, false));
  });

  it('lets the hover win when a thread is in both answers', () => {
    expect(threadPresence(0.5, true, true)).toBe(threadPresence(0.5, true, false));
  });
});

describe('threadTooCold', () => {
  it('drops every thread nobody asked about, however hot', () => {
    expect(threadTooCold(0.01, false, false)).toBe(true);
    expect(threadTooCold(1, false, false)).toBe(true);
  });

  it('never drops a thread the hover named, however cold', () => {
    expect(threadTooCold(0, true, false)).toBe(false);
  });

  it('keeps a standing thread on the ice-cold floor it always used', () => {
    expect(threadTooCold(0, false, true)).toBe(true);
    expect(threadTooCold(0.1, false, true)).toBe(false);
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
