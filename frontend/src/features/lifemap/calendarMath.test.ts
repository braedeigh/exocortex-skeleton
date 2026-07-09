import { describe, expect, it } from 'vitest';
import {
  activityTypeMap,
  addDaysISO,
  buildActivityDateMap,
  daysSinceLastOfType,
  daysSinceLastTrip,
  lastNDays,
  mondayOf,
  monthGrid,
  privateActTypes,
  runsThisWeek,
} from './calendarMath';
import type { ReminderDef } from '../todos/types';

describe('addDaysISO / lastNDays', () => {
  it('shifts across month boundaries', () => {
    expect(addDaysISO('2026-07-01', -1)).toBe('2026-06-30');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('builds an oldest-first window ending today', () => {
    const days = lastNDays('2026-07-09', 3);
    expect(days).toEqual(['2026-07-07', '2026-07-08', '2026-07-09']);
  });

  it('builds the 30-day window the grids use', () => {
    const days = lastNDays('2026-07-09', 30);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-06-10');
    expect(days[29]).toBe('2026-07-09');
  });
});

describe('monthGrid', () => {
  it('lays out July 2026 (starts Wednesday, 31 days)', () => {
    const g = monthGrid('2026-07-09', 0);
    expect(g.monthLabel).toBe('July 2026');
    // 2026-07-01 is a Wednesday -> Mon-first dow 2
    expect(g.startDow).toBe(2);
    expect(g.daysInMonth).toBe(31);
    expect(g.dates[0]).toBe('2026-07-01');
    expect(g.dates[30]).toBe('2026-07-31');
  });

  it('pages back through months with offset', () => {
    const g = monthGrid('2026-07-09', -1);
    expect(g.monthLabel).toBe('June 2026');
    expect(g.daysInMonth).toBe(30);
    // 2026-06-01 is a Monday
    expect(g.startDow).toBe(0);
  });

  it('crosses year boundaries', () => {
    const g = monthGrid('2026-01-15', -1);
    expect(g.monthLabel).toBe('December 2025');
  });
});

describe('buildActivityDateMap', () => {
  it('merges runs, trips and activity entries without duplicates', () => {
    const map = buildActivityDateMap(
      [{ date: '2026-07-01' }],
      [{ date: '2026-07-01' }],
      [
        { date: '2026-07-01', type: 'run' },
        { date: '2026-07-02', type: 'laundry-sheets' },
      ],
    );
    expect(map['2026-07-01']).toEqual(['run', 'kitchen']);
    expect(map['2026-07-02']).toEqual(['laundry-sheets']);
  });

  it('strips hidden (private) types', () => {
    const map = buildActivityDateMap([], [], [{ date: '2026-07-02', type: 'estradiol' }], ['estradiol']);
    expect(map['2026-07-02']).toBeUndefined();
  });
});

describe('activityTypeMap', () => {
  it('keeps the hardcoded system types as a base', () => {
    const map = activityTypeMap([]);
    expect(map.run.label).toBe('Run');
    expect(map.kitchen.shape).toBe('square');
  });

  it('overrides/extends from the reminder registry', () => {
    const reminders = [
      { id: '1', type: 'wash-hair', label: 'Hair day', color: '#123456', shape: 'ring', emoji: '🚿' },
      { id: '2', type: 'new-thing', label: 'New thing' },
    ] as unknown as ReminderDef[];
    const map = activityTypeMap(reminders);
    expect(map['wash-hair']).toMatchObject({ label: 'Hair day', color: '#123456', shape: 'ring' });
    // Unspecified color/shape fall back to defaults
    expect(map['new-thing']).toMatchObject({ label: 'New thing', color: '#9AA0B5', shape: 'circle' });
  });
});

describe('privateActTypes', () => {
  it('uses the server list when present, falls back otherwise', () => {
    expect(privateActTypes(['x'])).toEqual(['x']);
    expect(privateActTypes([])).toEqual(['estradiol', 'peptides']);
    expect(privateActTypes(undefined)).toEqual(['estradiol', 'peptides']);
  });
});

describe('stats math', () => {
  it('counts runs Monday..today', () => {
    // 2026-07-09 is a Thursday; Monday is 2026-07-06.
    expect(mondayOf('2026-07-09')).toBe('2026-07-06');
    const runs = [
      { date: '2026-07-05' }, // Sunday last week — excluded
      { date: '2026-07-06' },
      { date: '2026-07-09' },
      { date: '2026-07-10' }, // future — excluded
    ];
    expect(runsThisWeek(runs, '2026-07-09')).toBe(2);
  });

  it('days since last kitchen trip (last entry in sorted list)', () => {
    expect(daysSinceLastTrip([{ date: '2026-07-01' }, { date: '2026-07-07' }], '2026-07-09')).toBe(2);
    expect(daysSinceLastTrip([], '2026-07-09')).toBeNull();
  });

  it('days since last activity of a type', () => {
    const log = [
      { date: '2026-06-01', type: 'laundry-sheets' },
      { date: '2026-07-02', type: 'laundry-sheets' },
      { date: '2026-07-08', type: 'run' },
    ];
    expect(daysSinceLastOfType(log, 'laundry-sheets', '2026-07-09')).toBe(7);
    expect(daysSinceLastOfType(log, 'nope', '2026-07-09')).toBeNull();
  });
});
