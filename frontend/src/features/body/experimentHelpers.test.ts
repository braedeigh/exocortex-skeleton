import { describe, expect, it } from 'vitest';
import { canResolveClear, deriveExperimentState, moveInQueue, testDayNumber } from './experimentHelpers';
import type { FoodTest } from './types';

function test(overrides: Partial<FoodTest>): FoodTest {
  return {
    id: 't1',
    food: 'oats',
    started_on: '2026-07-01',
    watch_window_days: 3,
    results_due_on: '2026-07-04',
    outcome: null,
    outcome_at: null,
    cleared_baseline_on: null,
    ...overrides,
  };
}

describe('deriveExperimentState', () => {
  it('an unresolved test means testing', () => {
    const s = deriveExperimentState([test({})]);
    expect(s.phase).toBe('testing');
    expect(s.active?.id).toBe('t1');
    expect(s.recovering).toBeNull();
  });
  it('a flared test without baseline clearance means recovering', () => {
    const s = deriveExperimentState([test({ outcome: 'flared', outcome_at: '2026-07-02' })]);
    expect(s.phase).toBe('recovering');
    expect(s.recovering?.id).toBe('t1');
  });
  it('recovering picks the MOST RECENT un-cleared flare', () => {
    const s = deriveExperimentState([
      test({ id: 'old', outcome: 'flared' }),
      test({ id: 'new', outcome: 'flared' }),
    ]);
    expect(s.recovering?.id).toBe('new');
  });
  it('cleared/cleared-baseline tests mean clear; past lists resolved newest first', () => {
    const s = deriveExperimentState([
      test({ id: 'a', outcome: 'cleared', cleared_baseline_on: '2026-07-04' }),
      test({ id: 'b', outcome: 'flared', cleared_baseline_on: '2026-07-06' }),
    ]);
    expect(s.phase).toBe('clear');
    expect(s.past.map((t) => t.id)).toEqual(['b', 'a']);
  });
  it('no tests at all means clear', () => {
    expect(deriveExperimentState(undefined).phase).toBe('clear');
  });
});

describe('testDayNumber / canResolveClear', () => {
  it('day 1 on the start day, counting up', () => {
    expect(testDayNumber('2026-07-01', '2026-07-01')).toBe(1);
    expect(testDayNumber('2026-07-01', '2026-07-03')).toBe(3);
  });
  it('never below 1 (start date in the future)', () => {
    expect(testDayNumber('2026-07-05', '2026-07-01')).toBe(1);
  });
  it('clear unlocks only once the watch window has elapsed', () => {
    const t = test({ started_on: '2026-07-01', watch_window_days: 3 });
    expect(canResolveClear(t, '2026-07-02')).toBe(false);
    expect(canResolveClear(t, '2026-07-03')).toBe(true);
  });
});

describe('moveInQueue', () => {
  it('moves an item by delta, matching case-insensitively', () => {
    expect(moveInQueue(['Oats', 'corn', 'eggs'], 'CORN', -1)).toEqual(['corn', 'Oats', 'eggs']);
    expect(moveInQueue(['oats', 'corn', 'eggs'], 'oats', 1)).toEqual(['corn', 'oats', 'eggs']);
  });
  it('null on edge moves and unknown foods', () => {
    expect(moveInQueue(['oats', 'corn'], 'oats', -1)).toBeNull();
    expect(moveInQueue(['oats', 'corn'], 'corn', 1)).toBeNull();
    expect(moveInQueue(['oats'], 'kale', 1)).toBeNull();
  });
});
