import { describe, expect, it } from 'vitest';
import {
  applyBulk,
  applyBulkDetails,
  applyBulkMove,
  applyBulkRemove,
  applyBulkSnooze,
  applyStreakNotes,
  applyStreakRemove,
  applySymptomLog,
} from './optimistic';
import type { TodayData, TodoItem, TodoSection } from './types';

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

function todo(id: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return { id, text: `Task ${id}`, done: false, ...overrides };
}

function bulkData(): TodayData {
  return baseData({
    todos: [
      { name: 'Now', manual_order: false, items: [todo('a'), todo('b', { fronts: ['job'] })] },
      { name: 'Later', manual_order: false, items: [todo('c'), todo('d')] },
    ],
  });
}

function sectionItems(data: TodayData, name: string): TodoItem[] {
  const sections = data.todos as TodoSection[];
  return sections.find((s) => s.name === name)?.items ?? [];
}

describe('applyBulkDetails', () => {
  it('patches only the matched ids (fronts REPLACE, matching the bulk tag sheet)', () => {
    const next = applyBulkDetails(bulkData(), ['a', 'c'], { fronts: ['health'] });
    expect(sectionItems(next, 'Now').map((it) => it.fronts)).toEqual([['health'], ['job']]);
    expect(sectionItems(next, 'Later').map((it) => it.fronts)).toEqual([['health'], undefined]);
  });
  it('an empty-string value pops the key (details-route semantics)', () => {
    const data = baseData({
      todos: [{ name: 'Now', manual_order: false, items: [todo('a', { place_id: 'p1' })] }],
    });
    const next = applyBulkDetails(data, ['a'], { place_id: '' });
    expect('place_id' in sectionItems(next, 'Now')[0]).toBe(false);
  });
  it('an empty fronts list clears the key ("clear all fronts")', () => {
    const next = applyBulkDetails(bulkData(), ['b'], { fronts: [] });
    expect('fronts' in sectionItems(next, 'Now')[1]).toBe(false);
  });
});

describe('applyBulkSnooze', () => {
  it('sets snoozed_until on every matched id', () => {
    const next = applyBulkSnooze(bulkData(), ['a', 'd'], 3);
    expect(sectionItems(next, 'Now')[0].snoozed_until).toBe('2026-07-11');
    expect(sectionItems(next, 'Now')[1].snoozed_until).toBeUndefined();
    expect(sectionItems(next, 'Later')[1].snoozed_until).toBe('2026-07-11');
  });
  it('days 0 clears the snooze', () => {
    const data = baseData({
      todos: [{ name: 'Now', manual_order: false, items: [todo('a', { snoozed_until: '2026-07-20' })] }],
    });
    const next = applyBulkSnooze(data, ['a'], 0);
    expect(sectionItems(next, 'Now')[0].snoozed_until).toBeNull();
  });
});

describe('applyBulkMove', () => {
  it('strips matched items from other sections and APPENDS to the target', () => {
    const next = applyBulkMove(bulkData(), ['a', 'b'], 'Later');
    expect(sectionItems(next, 'Now').map((it) => it.id)).toEqual([]);
    expect(sectionItems(next, 'Later').map((it) => it.id)).toEqual(['c', 'd', 'a', 'b']);
  });
  it('leaves items already in the target where they are', () => {
    const next = applyBulkMove(bulkData(), ['b', 'c'], 'Later');
    expect(sectionItems(next, 'Now').map((it) => it.id)).toEqual(['a']);
    expect(sectionItems(next, 'Later').map((it) => it.id)).toEqual(['c', 'd', 'b']);
  });
});

describe('applyBulkRemove', () => {
  it('filters matched ids out of every section', () => {
    const next = applyBulkRemove(bulkData(), ['b', 'c']);
    expect(sectionItems(next, 'Now').map((it) => it.id)).toEqual(['a']);
    expect(sectionItems(next, 'Later').map((it) => it.id)).toEqual(['d']);
  });
});

describe('applyBulk', () => {
  it('dispatches on the action discriminant', () => {
    const next = applyBulk(bulkData(), ['a'], { action: 'remove' });
    expect(sectionItems(next, 'Now').map((it) => it.id)).toEqual(['b']);
  });
  it('passes frosted todos through untouched', () => {
    const data = baseData({ todos: { _frosted: true, shape: 'sections' } });
    expect(applyBulk(data, ['a'], { action: 'snooze', days: 3 })).toBe(data);
  });
});

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
