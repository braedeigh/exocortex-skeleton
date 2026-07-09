import { describe, expect, it } from 'vitest';
import {
  GRID_GRAY,
  GRID_METRICS,
  buildDaySymptomsPayload,
  cleanDefinitions,
  dateShortParts,
  dotInfo,
  noseSprayStreakFlags,
} from './dotGridHelpers';
import type { BodyHealthDay } from './types';

const metric = (key: string) => {
  const m = GRID_METRICS.find((x) => x.key === key);
  if (!m) throw new Error(`no metric ${key}`);
  return m;
};

describe('noseSprayStreakFlags', () => {
  it('flags every day of a 3+ day run, none of a 2-day run', () => {
    const days = [
      { nose_spray: true },
      { nose_spray: true },
      { nose_spray: null },
      { nose_spray: true },
      { nose_spray: true },
      { nose_spray: true },
      { nose_spray: true },
    ];
    expect(noseSprayStreakFlags(days)).toEqual([false, false, false, true, true, true, true]);
  });
  it('false (nose_spray logged off) breaks a run like a gap does', () => {
    const days = [{ nose_spray: true }, { nose_spray: true }, { nose_spray: false }, { nose_spray: true }];
    expect(noseSprayStreakFlags(days)).toEqual([false, false, false, false]);
  });
  it('empty input -> empty output', () => {
    expect(noseSprayStreakFlags([])).toEqual([]);
  });
});

describe('dotInfo', () => {
  const day: BodyHealthDay = { date: '2026-07-08', energy: 0, headache: 0, brain_fog: 3 };

  it('energy runs red->green (0 Crashed is the bad end)', () => {
    expect(dotInfo(metric('energy'), day, false, undefined)).toEqual({
      color: 'var(--red)',
      tip: 'Crashed',
    });
  });
  it('symptoms run green->red (0 None is the good end)', () => {
    expect(dotInfo(metric('headache'), day, false, undefined).color).toBe('var(--green)');
    expect(dotInfo(metric('brain_fog'), day, false, undefined).color).toBe('var(--red)');
  });
  it('missing value is the gray no-data dot', () => {
    expect(dotInfo(metric('hand_pain'), day, false, undefined)).toEqual({
      color: GRID_GRAY,
      tip: 'No data',
    });
  });
  it('uses the user definition for the tooltip when set', () => {
    const defs = { brain_fog: { '3': 'Cannot hold a sentence' } };
    expect(dotInfo(metric('brain_fog'), day, false, defs).tip).toBe('Cannot hold a sentence');
  });
  it('nasal spray: gray unless used, accent when used, orange on a streak', () => {
    const spray = metric('nose_spray');
    expect(dotInfo(spray, { date: 'x' }, false, undefined)).toEqual({ color: GRID_GRAY, tip: 'Not used' });
    expect(dotInfo(spray, { date: 'x', nose_spray: true }, false, undefined).color).toBe('var(--accent)');
    const flagged = dotInfo(spray, { date: 'x', nose_spray: true }, true, undefined);
    expect(flagged.color).toBe('var(--orange)');
    expect(flagged.tip).toContain('3+ day streak');
  });
});

describe('dateShortParts', () => {
  it('splits the server-provided date_short', () => {
    expect(dateShortParts({ date: '2026-07-08', date_short: 'Jul 08' })).toEqual(['Jul', '08']);
  });
  it('derives from the ISO date when date_short is missing', () => {
    expect(dateShortParts({ date: '2026-07-08' })).toEqual(['Jul', '08']);
  });
});

describe('buildDaySymptomsPayload', () => {
  it('keeps picked/existing scores, drops never-logged fields, always sends nose_spray', () => {
    const payload = buildDaySymptomsPayload({ energy: 2, headache: 0, brain_fog: null }, true);
    expect(payload).toEqual({ energy: 2, headache: 0, nose_spray: 1 });
  });
  it('score 0 survives (must not be dropped as falsy)', () => {
    expect(buildDaySymptomsPayload({ energy: 0 }, false)).toEqual({ energy: 0, nose_spray: 0 });
  });
});

describe('cleanDefinitions', () => {
  it('drops empty strings and empty symptom groups', () => {
    const out = cleanDefinitions({
      energy: { '0': '  ', '1': 'Barely upright' },
      headache: { '2': '' },
    });
    expect(out).toEqual({ energy: { '1': 'Barely upright' } });
  });
});
