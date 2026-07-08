import { describe, expect, it } from 'vitest';
import { companionToPrompt, computeReminderState, daysSince, isReminderTimeGated, visibleReminders } from './reminderMath';
import type { ActivityEntry, ReminderDef } from './types';

const TODAY = '2026-07-08';

function reminder(overrides: Partial<ReminderDef> = {}): ReminderDef {
  return {
    id: 'r1',
    type: 'sheets',
    label: 'Change sheets',
    mode: 'log',
    schedule: 'interval',
    every_days: 3,
    overdue_days: 7,
    weekdays: [],
    times: [],
    private: false,
    ...overrides,
  };
}

describe('daysSince', () => {
  it('returns null when nothing logged', () => {
    expect(daysSince([], 'sheets', TODAY)).toBeNull();
  });

  it('returns 0 for logged today', () => {
    const entries: ActivityEntry[] = [{ date: TODAY, type: 'sheets' }];
    expect(daysSince(entries, 'sheets', TODAY)).toBe(0);
  });

  it('picks the most recent matching entry', () => {
    const entries: ActivityEntry[] = [
      { date: '2026-07-01', type: 'sheets' },
      { date: '2026-07-05', type: 'sheets' },
      { date: '2026-07-07', type: 'other' },
    ];
    expect(daysSince(entries, 'sheets', TODAY)).toBe(3);
  });
});

describe('computeReminderState — track mode', () => {
  it('never shows', () => {
    const r = reminder({ mode: 'track' });
    expect(computeReminderState(r, [], TODAY).show).toBe(false);
  });
});

describe('computeReminderState — interval schedule', () => {
  it('log mode hides when not due', () => {
    const r = reminder({ every_days: 3, overdue_days: 7 });
    const entries: ActivityEntry[] = [{ date: '2026-07-07', type: 'sheets' }];
    expect(computeReminderState(r, entries, TODAY).show).toBe(false);
  });

  it('log mode shows and is overdue past overdue_days', () => {
    const r = reminder({ every_days: 3, overdue_days: 7 });
    const entries: ActivityEntry[] = [{ date: '2026-06-25', type: 'sheets' }];
    const state = computeReminderState(r, entries, TODAY);
    expect(state.show).toBe(true);
    expect(state.tone).toBe('red');
    expect(state.overdue).toBe(true);
    expect(state.pulse).toBe(true);
  });

  it('never logged is due and overdue immediately', () => {
    const r = reminder({ every_days: 3, overdue_days: 7 });
    const state = computeReminderState(r, [], TODAY);
    expect(state.show).toBe(true);
    expect(state.daysText).toBe('never logged');
    expect(state.overdue).toBe(true);
  });

  it('countdown mode always shows, counting down when not due', () => {
    const r = reminder({ mode: 'countdown', every_days: 5, overdue_days: 10 });
    const entries: ActivityEntry[] = [{ date: '2026-07-06', type: 'sheets' }];
    const state = computeReminderState(r, entries, TODAY);
    expect(state.show).toBe(true);
    expect(state.tone).toBe('ongoing');
    expect(state.sub).toBe('Due in 3 days');
  });

  it('due_text overrides the default due wording', () => {
    const r = reminder({ every_days: 1, overdue_days: 3, due_text: 'Water the plants' });
    const entries: ActivityEntry[] = [{ date: '2026-07-07', type: 'sheets' }];
    const state = computeReminderState(r, entries, TODAY);
    expect(state.sub).toBe('Water the plants');
  });
});

describe('computeReminderState — weekly schedule', () => {
  it('hides with no weekdays selected', () => {
    const r = reminder({ schedule: 'weekly', weekdays: [] });
    expect(computeReminderState(r, [], TODAY).show).toBe(false);
  });

  it('due today (Wednesday) when unlogged since last scheduled day', () => {
    const r = reminder({ schedule: 'weekly', weekdays: [3] });
    const state = computeReminderState(r, [], TODAY);
    expect(state.show).toBe(true);
    expect(state.overdue).toBe(false);
  });

  it('overdue when a scheduled day passed unlogged', () => {
    const r = reminder({ schedule: 'weekly', weekdays: [1] });
    const state = computeReminderState(r, [], TODAY);
    expect(state.show).toBe(true);
    expect(state.tone).toBe('red');
    expect(state.overdue).toBe(true);
  });

  it('log mode hides once logged since the last scheduled day', () => {
    const r = reminder({ schedule: 'weekly', weekdays: [1] });
    const entries: ActivityEntry[] = [{ date: '2026-07-07', type: 'sheets' }];
    expect(computeReminderState(r, entries, TODAY).show).toBe(false);
  });
});

describe('isReminderTimeGated', () => {
  it('is gated when times is set and current time is not in it', () => {
    const r = reminder({ times: ['morning'] });
    expect(isReminderTimeGated(r, 'evening')).toBe(true);
    expect(isReminderTimeGated(r, 'morning')).toBe(false);
  });

  it('is never gated when times is empty', () => {
    const r = reminder({ times: [] });
    expect(isReminderTimeGated(r, 'evening')).toBe(false);
  });
});

describe('visibleReminders', () => {
  it('excludes snoozed reminders even if otherwise due', () => {
    const r = reminder({ snoozed_until: '2026-07-09' });
    expect(visibleReminders([r], [], TODAY, 'morning')).toHaveLength(0);
  });

  it('includes a due, ungated reminder', () => {
    const r = reminder({ every_days: 1, overdue_days: 3, times: ['morning'] });
    const entries: ActivityEntry[] = [{ date: '2026-07-06', type: 'sheets' }];
    expect(visibleReminders([r], entries, TODAY, 'morning')).toHaveLength(1);
    expect(visibleReminders([r], entries, TODAY, 'evening')).toHaveLength(0);
  });
});

describe('companionToPrompt', () => {
  it('returns null when the logged reminder has no companion', () => {
    const r = reminder();
    expect(companionToPrompt([r], [], 'sheets', TODAY)).toBeNull();
  });

  it('returns the companion reminder when unlogged today', () => {
    const src = reminder({ type: 'sheets', companion: 'eyemasks' });
    const comp = reminder({ id: 'r2', type: 'eyemasks', label: 'Wash eye masks' });
    expect(companionToPrompt([src, comp], [], 'sheets', TODAY)?.type).toBe('eyemasks');
  });

  it('returns null when the companion is already logged today', () => {
    const src = reminder({ type: 'sheets', companion: 'eyemasks' });
    const comp = reminder({ id: 'r2', type: 'eyemasks', label: 'Wash eye masks' });
    const entries: ActivityEntry[] = [{ date: TODAY, type: 'eyemasks' }];
    expect(companionToPrompt([src, comp], entries, 'sheets', TODAY)).toBeNull();
  });
});
