/**
 * streamPacing — the word flow's arithmetic: backlog-proportional release,
 * the carry accumulator, word-boundary snapping, the end-of-turn fast
 * drain, and stable tail-span keys.
 */
import { describe, expect, it } from 'vitest';
import {
  COOL_LINGER_MS,
  EMBER_LINGER_MS,
  EMBER_SPREAD_MS,
  PACE_DRAIN_MAX_CPS,
  PACE_DRAIN_MS,
  PACE_HORIZON_MS,
  PACE_MAX_CPS,
  PACE_MIN_CPS,
  cooledFrontier,
  emberDelay,
  paceStep,
  pruneSamples,
  tailWords,
} from './streamPacing';

describe('emberDelay', () => {
  it('gives the same word the same delay every time', () => {
    // The whole reason it's a hash and not a random draw: a re-render must not
    // re-roll a mounted span's delay, or its fade restarts.
    expect(emberDelay(4210)).toBe(emberDelay(4210));
  });

  it('stays inside the scatter window', () => {
    for (let key = 0; key < 500; key++) {
      const d = emberDelay(key);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(EMBER_SPREAD_MS);
    }
  });

  it('scatters neighbouring words instead of ramping them', () => {
    // Keys are character offsets, so consecutive words sit a few apart. If
    // near keys produced near delays the effect would read as a slow wipe
    // rather than embers catching — so adjacent draws must jump around.
    const deltas: number[] = [];
    for (let key = 0; key < 200; key += 5) deltas.push(emberDelay(key + 5) - emberDelay(key));
    const bigJumps = deltas.filter((d) => Math.abs(d) > EMBER_SPREAD_MS / 4).length;
    expect(bigJumps).toBeGreaterThan(deltas.length / 2);
  });

  it('spreads across the whole window rather than clustering', () => {
    const buckets = new Set<number>();
    for (let key = 0; key < 300; key++) buckets.add(Math.floor(emberDelay(key) / 100));
    expect(buckets.size).toBeGreaterThanOrEqual(Math.floor(EMBER_SPREAD_MS / 100));
  });

  it('collapses to zero if the window is closed', () => {
    expect(emberDelay(77, 0)).toBe(0);
  });

  it('waits out the scatter before a paragraph may settle', () => {
    // A word can sit unlit for the whole spread, then fade, then cool. Settling
    // before all three unmounts its span and snaps it straight to ink.
    expect(EMBER_LINGER_MS).toBeGreaterThan(EMBER_SPREAD_MS + COOL_LINGER_MS - 450);
    expect(EMBER_LINGER_MS).toBeGreaterThan(COOL_LINGER_MS);
  });
});

describe('paceStep', () => {
  it('does nothing when everything is already shown', () => {
    expect(paceStep('hello', { shown: 5, carry: 3 }, true, 50)).toEqual({ shown: 5, carry: 0 });
  });

  it('clamps a frontier the source has shrunk out from under', () => {
    // delta buffer folded into the authoritative message and lost a char
    expect(paceStep('hi', { shown: 10, carry: 0 }, true, 50)).toEqual({ shown: 2, carry: 0 });
  });

  it('accumulates sub-character debt across ticks instead of stalling', () => {
    // 10-char backlog at the MIN rate (30cps): a 20ms tick owes 0.6 chars
    const s1 = paceStep('0123456789', { shown: 0, carry: 0 }, true, 20);
    expect(s1.shown).toBe(0);
    expect(s1.carry).toBeCloseTo(0.6);
    // the next tick tips the carry over 1 and releases
    const s2 = paceStep('0123456789', s1, true, 20);
    expect(s2.shown).toBeGreaterThan(0);
  });

  it('releases proportionally to the backlog while writing', () => {
    const source = 'xxxxxxxxx '.repeat(480); // 4800 chars of 10-char words
    // 4800 chars over a 1200ms horizon = 4000cps; a 50ms tick releases ~200
    const s = paceStep(source, { shown: 0, carry: 0 }, true, 50);
    expect(s.shown).toBeGreaterThanOrEqual(190);
    expect(s.shown).toBeLessThanOrEqual(215); // + at most one word of snap
  });

  it('snaps a mid-word release forward to the end of the word', () => {
    // enough carry to land inside "boundary" — the whole word comes with
    const s = paceStep('word boundary here', { shown: 5, carry: 3.5 }, true, 0);
    expect(s.shown).toBe(13); // "word boundary"
    expect(s.carry).toBe(0);
  });

  it('does not over-extend from a clean word start', () => {
    // landing exactly at the start of "there" is already a boundary
    const s = paceStep('hi there', { shown: 0, carry: 3.2 }, true, 0);
    expect(s.shown).toBe(3); // "hi " — index 3 is the 't', behind it a space
  });

  it('keeps draining after the turn ends, but at a readable cap — not a dump', () => {
    // A short reply is mostly backlog when the turn ends (the bug she saw:
    // "that printed way too fast"). The drain must stay watchable.
    const source = 'xxxxxxxxx '.repeat(120); // 1200 chars of 10-char words
    const done = paceStep(source, { shown: 0, carry: 0 }, false, 50);
    expect(done.shown).toBeGreaterThan(0); // still moving
    expect(done.shown).toBeLessThanOrEqual((PACE_DRAIN_MAX_CPS * 50) / 1000 + 10);
    // the drain horizon is the writing horizon shrunk
    expect(PACE_DRAIN_MS).toBeLessThan(PACE_HORIZON_MS);
  });

  it('keeps the rate inside its floor and ceiling', () => {
    // tiny backlog: floor. 30cps × 1s = 30 chars — but only 4 exist
    const tiny = paceStep('abcd', { shown: 0, carry: 0 }, true, 1000);
    expect(tiny.shown).toBe(4);
    // huge backlog: ceiling caps a single tick's release
    const huge = paceStep('xxxxxxxxx '.repeat(100_000), { shown: 0, carry: 0 }, true, 50);
    expect(huge.shown).toBeLessThanOrEqual((PACE_MAX_CPS * 50) / 1000 + 10);
    expect(huge.shown).toBeGreaterThanOrEqual(PACE_MIN_CPS * 0.05 - 1);
  });
});

describe('tailWords', () => {
  it('tokenizes words with their leading whitespace, keyed by offset', () => {
    expect(tailWords('Hello brave new', 100)).toEqual([
      { key: 100, text: 'Hello' },
      { key: 105, text: ' brave' },
      { key: 111, text: ' new' },
    ]);
  });

  it('keeps keys stable as the tail grows — spans mount once', () => {
    const before = tailWords('one two', 0);
    const after = tailWords('one two three', 0);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it('attaches a leading newline run to the first word', () => {
    const words = tailWords('\n\nFresh paragraph', 40);
    expect(words[0]).toEqual({ key: 40, text: '\n\nFresh' });
  });

  it('drops trailing whitespace until its word arrives', () => {
    // "word " renders as just "word"; the space joins the NEXT word's span
    expect(tailWords('word ', 0)).toEqual([{ key: 0, text: 'word' }]);
  });
});

describe('cooledFrontier', () => {
  it('is the newest frontier at least the linger old', () => {
    const now = 100_000;
    const samples = [
      { t: now - COOL_LINGER_MS - 500, shown: 40 },
      { t: now - COOL_LINGER_MS, shown: 90 },
      { t: now - 1000, shown: 300 }, // still hot — words mid-cool
    ];
    expect(cooledFrontier(samples, now)).toBe(90);
  });

  it('is zero while everything is still hot', () => {
    expect(cooledFrontier([{ t: 99_500, shown: 200 }], 100_000)).toBe(0);
    expect(cooledFrontier([], 100_000)).toBe(0);
  });
});

describe('pruneSamples', () => {
  it('keeps the newest cooled sample and everything hotter', () => {
    const now = 100_000;
    const samples = [
      { t: now - COOL_LINGER_MS - 900, shown: 10 },
      { t: now - COOL_LINGER_MS - 400, shown: 50 },
      { t: now - 200, shown: 400 },
    ];
    const pruned = pruneSamples(samples, now);
    expect(pruned).toEqual(samples.slice(1));
    // pruning never changes the answer
    expect(cooledFrontier(pruned, now)).toBe(cooledFrontier(samples, now));
  });

  it('leaves an all-hot list alone', () => {
    const samples = [{ t: 99_900, shown: 100 }];
    expect(pruneSamples(samples, 100_000)).toEqual(samples);
  });
});
