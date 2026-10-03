/**
 * heatRamps.test.ts — the map's three heat ramps stay three different colours.
 *
 * The threads used to be drawn on the GOLD ramp, which made "this file ran"
 * and "this file feeds that one" the same hue. They have their own teal now.
 * That separation is a one-word edit away from being undone by accident
 * (`gold` and `thread` are neighbouring keys on the same object), and nothing
 * would fail — the map would just quietly go back to speaking one colour for
 * two things. Hence this.
 */
import { describe, expect, it } from 'vitest';
import {
  GOLD_HOT,
  THREAD_TEAL,
  heatRamps,
  type ThemeInk,
} from './terrainCanvas';

const ink = (dark: boolean): ThemeInk => ({
  bg: dark ? '#14101e' : '#f5f0e8',
  text: dark ? '#ddd0e8' : '#1a1815',
  textSecondary: '#888888',
  textMuted: '#777777',
  border: dark ? '#2e2545' : '#888391',
  accent: '#7c5cbf',
  evening: '#6a7acc',
  orange: '#d4700a',
  messageGreen: '#5c9a2b',
  helperBlue: '#4f8fe6',
  ash: dark ? '#313131' : '#cccccc',
  dark,
});

describe('heatRamps', () => {
  for (const dark of [true, false]) {
    const surface = dark ? 'dark' : 'light';

    it(`gives threads a ramp of their own on the ${surface} surface`, () => {
      const { gold, thread } = heatRamps(ink(dark));
      expect(thread).toHaveLength(gold.length);
      // Every LIT step differs, not just the hot end — a thread at any heat
      // has to be tellable from a run-hot dot at the same heat. The cold end
      // is excepted because the ramps deliberately share it (see below):
      // everything the map has stopped caring about fades to the same floor.
      thread.slice(1).forEach((step, i) => expect(step).not.toBe(gold[i + 1]));
    });

    it(`lands the thread ramp on the teal hot end on the ${surface} surface`, () => {
      const { thread } = heatRamps(ink(dark));
      expect(thread[thread.length - 1]?.toLowerCase()).toBe(THREAD_TEAL.toLowerCase());
    });

    it(`leaves the gold ramp on the run channel hot end on the ${surface} surface`, () => {
      // Gold still means "this ran" — moving the threads off it must not have
      // moved the run channel too.
      const { gold } = heatRamps(ink(dark));
      expect(gold[gold.length - 1]?.toLowerCase()).toBe(GOLD_HOT.toLowerCase());
    });
  }

  it('shares one cold end across all three ramps on the dark surface', () => {
    // Ash is the floor both fires and the threads fade into, so nothing on
    // the surface can disagree about where cold is.
    const { ember, gold, thread } = heatRamps(ink(true));
    expect(ember[0]).toBe(gold[0]);
    expect(thread[0]).toBe(gold[0]);
  });
});
