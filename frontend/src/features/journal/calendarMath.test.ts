import { describe, expect, it } from 'vitest';
import { addMonths, buildCalendarCells, dateStr, daysInMonth, monthLabel, startDow } from './calendarMath';

describe('addMonths', () => {
  it('adds within the same year', () => {
    expect(addMonths({ year: 2026, month: 6 }, 1)).toEqual({ year: 2026, month: 7 });
  });
  it('rolls forward over a year boundary', () => {
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
  });
  it('rolls backward over a year boundary', () => {
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });
  it('handles a jump of more than one year', () => {
    expect(addMonths({ year: 2026, month: 0 }, -14)).toEqual({ year: 2024, month: 10 });
  });
});

describe('daysInMonth', () => {
  it('gets 31 for July', () => {
    expect(daysInMonth(2026, 6)).toBe(31);
  });
  it('gets 28 for a non-leap February', () => {
    expect(daysInMonth(2026, 1)).toBe(28);
  });
  it('gets 29 for a leap February', () => {
    expect(daysInMonth(2028, 1)).toBe(29);
  });
});

describe('startDow', () => {
  it('is Monday-first (0)', () => {
    // 2026-06-01 is a Monday
    expect(startDow(2026, 5)).toBe(0);
  });
  it('is 6 for a month starting on Sunday', () => {
    // 2026-11-01 is a Sunday
    expect(startDow(2026, 10)).toBe(6);
  });
});

describe('dateStr', () => {
  it('zero-pads month and day', () => {
    expect(dateStr(2026, 0, 5)).toBe('2026-01-05');
  });
});

describe('monthLabel', () => {
  it('renders "Month YYYY"', () => {
    expect(monthLabel(2026, 6)).toBe('July 2026');
  });
});

describe('buildCalendarCells', () => {
  it('leads with blank cells matching the offset and marks today/selected/hasEntry', () => {
    const journalDates = new Set(['2026-07-05', '2026-07-08']);
    const cells = buildCalendarCells(2026, 6, journalDates, '2026-07-08', '2026-07-05');
    // July 2026 starts on a Wednesday -> 2 leading blanks (Mon, Tue)
    expect(cells.slice(0, 2)).toEqual([
      { day: null, date: null, hasEntry: false, isToday: false, isSelected: false },
      { day: null, date: null, hasEntry: false, isToday: false, isSelected: false },
    ]);
    expect(cells).toHaveLength(2 + 31);

    const day8 = cells.find((c) => c.date === '2026-07-08');
    expect(day8).toEqual({ day: 8, date: '2026-07-08', hasEntry: true, isToday: true, isSelected: false });

    const day5 = cells.find((c) => c.date === '2026-07-05');
    expect(day5).toEqual({ day: 5, date: '2026-07-05', hasEntry: true, isToday: false, isSelected: true });

    const day6 = cells.find((c) => c.date === '2026-07-06');
    expect(day6?.hasEntry).toBe(false);
  });
});
