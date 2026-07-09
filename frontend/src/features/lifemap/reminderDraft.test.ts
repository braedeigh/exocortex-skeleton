import { describe, expect, it } from 'vitest';
import { coerceDraftsForSave, newDraft, seedDrafts, toggleTime, toggleWeekday } from './reminderDraft';
import type { ReminderDef } from '../todos/types';

describe('seedDrafts', () => {
  it('copies fields with the old defaults', () => {
    const drafts = seedDrafts([
      { id: 'r1', type: 'laundry-sheets', label: 'Sheets', every_days: 7, overdue_days: 10 } as ReminderDef,
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: 'r1',
      type: 'laundry-sheets',
      label: 'Sheets',
      color: '#9AA0B5',
      shape: 'circle',
      schedule: 'interval',
      mode: 'log',
      companion: '',
      private: false,
      due_text: '',
    });
  });

  it('clones weekdays/times arrays (draft edits must not touch live data)', () => {
    const src = { id: 'r1', type: 't', label: 'L', weekdays: [1, 3], times: ['morning'] } as unknown as ReminderDef;
    const drafts = seedDrafts([src]);
    drafts[0].weekdays.push(5);
    expect(src.weekdays).toEqual([1, 3]);
  });
});

describe('toggleWeekday', () => {
  it('adds keeping numeric sort, removes on second toggle', () => {
    expect(toggleWeekday([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggleWeekday([1, 3, 5], 3)).toEqual([1, 5]);
  });
});

describe('toggleTime', () => {
  it('keeps canonical morning/afternoon/evening order', () => {
    expect(toggleTime(['evening'], 'morning')).toEqual(['morning', 'evening']);
    expect(toggleTime(['morning', 'evening'], 'evening')).toEqual(['morning']);
  });
});

describe('coerceDraftsForSave', () => {
  it('drops blank-label rows and trims strings', () => {
    const rows = coerceDraftsForSave([
      { ...newDraft(), label: '   ' },
      { ...newDraft(), label: '  Sheets  ', emoji: ' 🛏 ', type: ' laundry-sheets ' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Sheets');
    expect(rows[0].emoji).toBe('🛏');
    expect(rows[0].type).toBe('laundry-sheets');
  });

  it('coerces numbers (empty -> 1) and omits blank id/type/color', () => {
    const rows = coerceDraftsForSave([
      { ...newDraft(), label: 'X', every_days: '', overdue_days: '', type: '', color: '' },
    ]);
    expect(rows[0].every_days).toBe(1);
    expect(rows[0].overdue_days).toBe(1);
    expect(rows[0].id).toBeUndefined();
    expect(rows[0].type).toBeUndefined();
    expect(rows[0].color).toBeUndefined();
  });

  it('forces unknown modes to log and weekly-only schedules to interval', () => {
    const bad = { ...newDraft(), label: 'X', mode: 'bogus' as never, schedule: 'nope' as never };
    const rows = coerceDraftsForSave([bad]);
    expect(rows[0].mode).toBe('log');
    expect(rows[0].schedule).toBe('interval');
  });
});
