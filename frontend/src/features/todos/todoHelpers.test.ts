import { describe, expect, it } from 'vitest';
import {
  addDays,
  collectSnoozed,
  computeFocusCounts,
  focusMatch,
  fmtAddedDate,
  fmtDuration,
  fmtTime,
  isDoneSection,
  isOverdue,
  isSnoozed,
  themeLabel,
} from './todoHelpers';
import type { TodoItem, TodoSection } from './types';

const TODAY = '2026-07-08';

function item(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 'a', text: 'Do a thing', done: false, ...overrides };
}

describe('isOverdue', () => {
  it('is overdue when due_by is before server_date', () => {
    expect(isOverdue('2026-07-07', TODAY)).toBe(true);
  });
  it('is not overdue when due today or in the future', () => {
    expect(isOverdue('2026-07-08', TODAY)).toBe(false);
    expect(isOverdue('2026-07-09', TODAY)).toBe(false);
  });
  it('is not overdue when unset', () => {
    expect(isOverdue(null, TODAY)).toBe(false);
  });
});

describe('isSnoozed', () => {
  it('is snoozed when snoozed_until is in the future and not done', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-09' }), TODAY)).toBe(true);
  });
  it('is not snoozed once the wake date has passed', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-08' }), TODAY)).toBe(false);
  });
  it('a done item is never snoozed', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-09', done: true }), TODAY)).toBe(false);
  });
});

describe('focusMatch', () => {
  it('matches everything when theme is empty', () => {
    expect(focusMatch(item({ theme: 'job' }), '')).toBe(true);
  });
  it('__none__ matches only untagged items', () => {
    expect(focusMatch(item({ theme: undefined }), '__none__')).toBe(true);
    expect(focusMatch(item({ theme: 'job' }), '__none__')).toBe(false);
  });
  it('matches an exact theme', () => {
    expect(focusMatch(item({ theme: 'job' }), 'job')).toBe(true);
    expect(focusMatch(item({ theme: 'health' }), 'job')).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('fmtTime converts 24h to 12h with am/pm', () => {
    expect(fmtTime('09:05')).toBe('9:05am');
    expect(fmtTime('13:30')).toBe('1:30pm');
    expect(fmtTime('00:00')).toBe('12:00am');
    expect(fmtTime(null)).toBe('');
  });

  it('fmtDuration renders minutes, hours, and mixed', () => {
    expect(fmtDuration(45)).toBe('45m');
    expect(fmtDuration(60)).toBe('1h');
    expect(fmtDuration(90)).toBe('1h30');
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(null)).toBe('');
  });

  it('fmtAddedDate renders a short month/day label', () => {
    expect(fmtAddedDate('2026-07-08')).toBe('Jul 8');
    expect(fmtAddedDate(null)).toBe('');
  });
});

describe('addDays', () => {
  it('adds days and clears/handles month rollover', () => {
    expect(addDays('2026-07-08', 3)).toBe('2026-07-11');
    expect(addDays('2026-07-30', 3)).toBe('2026-08-02');
  });
});

describe('themeLabel', () => {
  it('resolves a known theme to emoji + label', () => {
    expect(themeLabel('job')).toBe('💼 Job');
  });
  it('resolves __none__ to Other', () => {
    expect(themeLabel('__none__')).toBe('🏷️ Other');
  });
  it('falls back to the raw key for unknown themes', () => {
    expect(themeLabel('mystery')).toBe('mystery');
  });
});

describe('isDoneSection', () => {
  it('matches Done regardless of case or trailing annotation', () => {
    expect(isDoneSection('Done')).toBe(true);
    expect(isDoneSection('done — archived')).toBe(true);
    expect(isDoneSection('Now')).toBe(false);
  });
});

function section(name: string, items: TodoItem[], manual_order = false): TodoSection {
  return { name, items, manual_order };
}

describe('computeFocusCounts', () => {
  it('counts live items by theme, excluding done, snoozed, and the Done section', () => {
    const sections: TodoSection[] = [
      section('Now', [
        item({ id: '1', theme: 'job' }),
        item({ id: '2', theme: 'job', done: true }),
        item({ id: '3', theme: 'health', snoozed_until: '2026-07-09' }),
        item({ id: '4' }),
      ]),
      section('Done', [item({ id: '5', theme: 'job', done: true })]),
    ];
    const counts = computeFocusCounts(sections, TODAY);
    expect(counts.total).toBe(2);
    expect(counts.byTheme.job).toBe(1);
    expect(counts.none).toBe(1);
    expect(counts.byTheme.health).toBeUndefined();
  });
});

describe('collectSnoozed', () => {
  it('gathers snoozed items across sections, sorted by wake date', () => {
    const sections: TodoSection[] = [
      section('Now', [item({ id: '1', snoozed_until: '2026-07-20' })]),
      section('Later', [item({ id: '2', snoozed_until: '2026-07-10' })]),
      section('Done', [item({ id: '3', snoozed_until: '2026-07-01', done: true })]),
    ];
    const snoozed = collectSnoozed(sections, TODAY);
    expect(snoozed.map((i) => i.id)).toEqual(['2', '1']);
  });
});
