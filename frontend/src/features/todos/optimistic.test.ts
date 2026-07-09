import { describe, expect, it } from 'vitest';
import { applyStreakNotes, applyStreakRemove, applySymptomLog } from './optimistic';
import type { TodayData } from './types';

const TODAY = '2026-07-08';

function baseData(overrides: Partial<TodayData> = {}): TodayData {
  return {
    server_date: TODAY,
    server_hour: 9,
    time_of_day: 'morning',
    todos: [],
    activity_log: [],
    private_act_types: [],
    ...overrides,
  };
}

describe('applySymptomLog', () => {
  it('merges into an existing health_data row', () => {
    const data = baseData({ health_data: [{ date: TODAY, energy: null, headache: 1 }] });
    const next = applySymptomLog(data, TODAY, { energy: 2, brain_fog: 1 });
    expect(next.health_data).toEqual([{ date: TODAY, energy: 2, headache: 1, brain_fog: 1 }]);
  });
  it('inserts a row when the date has none', () => {
    const data = baseData({ health_data: [{ date: '2026-07-07', energy: 3 }] });
    const next = applySymptomLog(data, TODAY, { energy: 1 });
    expect(next.health_data).toHaveLength(2);
    expect(next.health_data?.[1]).toEqual({ date: TODAY, energy: 1 });
  });
  it('leaves data untouched when health_data is absent', () => {
    const data = baseData();
    expect(applySymptomLog(data, TODAY, { energy: 1 })).toBe(data);
  });
});

describe('applyStreakNotes', () => {
  it('patches only the streak matching label+since', () => {
    const data = baseData({
      streaks: [
        { label: 'on doxy', days: 4, since: '2026-07-04' },
        { label: 'on doxy', days: 40, since: '2026-05-29', notes: 'old' },
      ],
    });
    const next = applyStreakNotes(data, 'on doxy', '2026-07-04', '100mg 2x/day');
    expect(next.streaks).toEqual([
      { label: 'on doxy', days: 4, since: '2026-07-04', notes: '100mg 2x/day' },
      { label: 'on doxy', days: 40, since: '2026-05-29', notes: 'old' },
    ]);
  });
});

describe('applyStreakRemove', () => {
  it('removes only the streak matching label+since', () => {
    const data = baseData({
      streaks: [
        { label: 'on doxy', days: 4, since: '2026-07-04' },
        { label: 'off soda', days: 12, since: '2026-06-26' },
      ],
    });
    const next = applyStreakRemove(data, 'on doxy', '2026-07-04');
    expect(next.streaks).toEqual([{ label: 'off soda', days: 12, since: '2026-06-26' }]);
  });
  it('leaves a frosted streaks stream untouched', () => {
    const data = baseData({ streaks: { _frosted: true, shape: 'chips' } });
    expect(applyStreakRemove(data, 'x', '2026-07-04')).toBe(data);
  });
});
