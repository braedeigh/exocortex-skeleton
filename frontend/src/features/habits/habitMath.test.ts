import { describe, expect, it } from 'vitest';
import {
  courseInfo,
  dailySectionViews,
  habitCadence,
  habitCount,
  habitKey,
  habitSectionDefs,
  habitStartLabel,
  habitsReadyToGraduate,
  isGradSnoozed,
  isGraduated,
  pickTimeSegment,
  promoteTarget,
  readyToGraduate,
  readyToPromote,
  recentHabitDone,
  showsInDaily,
  spotCheckDue,
} from './habitMath';
import type { CadenceConfig, HabitCadenceMap, HabitMetaMap, HabitSection, HabitsLog } from './types';

const TODAY = '2026-07-08'; // a Wednesday

function log(entries: Record<string, string[]>): HabitsLog {
  const out: HabitsLog = {};
  for (const [date, keys] of Object.entries(entries)) {
    out[date] = {};
    for (const k of keys) out[date][k] = true;
  }
  return out;
}

describe('habitKey', () => {
  it('lowercases + trims the section and joins with |', () => {
    expect(habitKey('Morning', 'Water')).toBe('morning|Water');
    expect(habitKey('  Evening / Night  ', 'Floss')).toBe('evening / night|Floss');
  });
  it('treats an empty section as a bare key', () => {
    expect(habitKey('', 'Legacy')).toBe('|Legacy');
  });
});

describe('habitCadence / isGraduated', () => {
  const map: HabitCadenceMap = {
    'morning|Doxycycline': { stage: 'weekly', next_check: '2026-07-10', passes: 2 },
  };
  it('finds an entry by section + item', () => {
    expect(habitCadence(map, 'Morning', 'Doxycycline')?.stage).toBe('weekly');
  });
  it('returns null for a plain daily habit (no ladder entry)', () => {
    expect(habitCadence(map, 'Morning', 'Kefir')).toBeNull();
  });
  it('weekly/monthly count as graduated, retired and null do not', () => {
    expect(isGraduated({ stage: 'weekly' })).toBe(true);
    expect(isGraduated({ stage: 'monthly' })).toBe(true);
    expect(isGraduated({ stage: 'retired' })).toBe(false);
    expect(isGraduated(null)).toBe(false);
  });
});

describe('recentHabitDone', () => {
  it('counts hits in the trailing window, inclusive of today', () => {
    const l = log({
      '2026-07-08': ['morning|Stretch'],
      '2026-07-07': ['morning|Stretch'],
      '2026-07-01': ['morning|Stretch'], // outside a 5-day window
    });
    expect(recentHabitDone(l, 'Morning', 'Stretch', 5, TODAY)).toBe(2);
    expect(recentHabitDone(l, 'Morning', 'Stretch', 30, TODAY)).toBe(3);
  });
  it('is 0 when nothing logged', () => {
    expect(recentHabitDone({}, 'Morning', 'Stretch', 30, TODAY)).toBe(0);
  });
});

describe('habitCount', () => {
  it('counts every dated hit across the whole log', () => {
    const l = log({
      '2026-01-01': ['morning|Kefir'],
      '2026-03-15': ['morning|Kefir'],
      '2026-07-08': ['morning|Kefir', 'midday|Kefir'], // different section = different key
    });
    expect(habitCount(l, 'Kefir', 'Morning')).toBe(3);
    expect(habitCount(l, 'Kefir', 'Midday')).toBe(1);
  });
});

describe('readyToGraduate', () => {
  const cfg: CadenceConfig = { graduate_count: 60, graduate_recent: [24, 30] };

  function bigLog(hitDays: number): HabitsLog {
    const entries: Record<string, string[]> = {};
    for (let i = 0; i < hitDays; i++) {
      const d = new Date(`${TODAY}T12:00:00`);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      entries[ds] = ['morning|Kefir'];
    }
    return log(entries);
  }

  it('is true once lifetime count and recent consistency both clear the bar', () => {
    const l = bigLog(60); // 60 total, all in the last 30 days too
    expect(readyToGraduate('Morning', 'Kefir', {}, {}, l, cfg, TODAY)).toBe(true);
  });

  it('is false below the lifetime threshold even if recently perfect', () => {
    const l = bigLog(30);
    expect(readyToGraduate('Morning', 'Kefir', {}, {}, l, cfg, TODAY)).toBe(false);
  });

  it('is false when lifetime count is high but consistency lapsed recently', () => {
    // 60 lifetime hits, but only counting every other day recently = below 24/30
    const entries: Record<string, string[]> = {};
    for (let i = 0; i < 120; i += 2) {
      const d = new Date(`${TODAY}T12:00:00`);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      entries[ds] = ['morning|Kefir'];
    }
    const l = log(entries);
    expect(habitCount(l, 'Kefir', 'Morning')).toBeGreaterThanOrEqual(60);
    expect(readyToGraduate('Morning', 'Kefir', {}, {}, l, cfg, TODAY)).toBe(false);
  });

  it('is false once already on the cadence ladder', () => {
    const l = bigLog(60);
    const cadenceMap: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly' } };
    expect(readyToGraduate('Morning', 'Kefir', cadenceMap, {}, l, cfg, TODAY)).toBe(false);
  });

  it('is false for a course/temporary habit', () => {
    const l = bigLog(60);
    const metaMap: HabitMetaMap = { 'morning|Doxycycline': { course_start: '2026-07-01', course_days: 10 } };
    expect(readyToGraduate('Morning', 'Doxycycline', {}, metaMap, l, cfg, TODAY)).toBe(false);
  });
});

describe('readyToPromote / promoteTarget', () => {
  const cfg: CadenceConfig = { weekly_to_monthly: 4, monthly_to_retire: 3 };
  it('weekly graduates to monthly at the configured pass count', () => {
    expect(readyToPromote({ stage: 'weekly', passes: 3 }, cfg)).toBe(false);
    expect(readyToPromote({ stage: 'weekly', passes: 4 }, cfg)).toBe(true);
    expect(promoteTarget({ stage: 'weekly' }, cfg)).toBe(4);
  });
  it('monthly graduates to retire at the configured pass count', () => {
    expect(readyToPromote({ stage: 'monthly', passes: 2 }, cfg)).toBe(false);
    expect(readyToPromote({ stage: 'monthly', passes: 3 }, cfg)).toBe(true);
    expect(promoteTarget({ stage: 'monthly' }, cfg)).toBe(3);
  });
  it('retired never promotes further', () => {
    expect(readyToPromote({ stage: 'retired', passes: 99 }, cfg)).toBe(false);
    expect(promoteTarget({ stage: 'retired' }, cfg)).toBe(0);
  });
});

describe('spotCheckDue', () => {
  const cfg: CadenceConfig = { grace_days: 1 };
  it('is false for a non-graduated habit', () => {
    expect(spotCheckDue({}, 'Morning', 'Kefir', TODAY, cfg)).toBe(false);
  });
  it('is false before the check date', () => {
    const map: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: '2026-07-09' } };
    expect(spotCheckDue(map, 'Morning', 'Kefir', TODAY, cfg)).toBe(false);
  });
  it('is true exactly on the check date', () => {
    const map: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: TODAY } };
    expect(spotCheckDue(map, 'Morning', 'Kefir', TODAY, cfg)).toBe(true);
  });
  it('is true within the grace window after the check date', () => {
    const map: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: '2026-07-07' } };
    expect(spotCheckDue(map, 'Morning', 'Kefir', TODAY, cfg)).toBe(true); // 1 day late, grace=1
  });
  it('is false past the grace window', () => {
    const map: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: '2026-07-05' } };
    expect(spotCheckDue(map, 'Morning', 'Kefir', TODAY, cfg)).toBe(false); // 3 days late, grace=1
  });
});

describe('courseInfo', () => {
  it('computes the current day number and expiry', () => {
    const metaMap: HabitMetaMap = { 'morning|Doxycycline': { course_start: '2026-07-01', course_days: 10 } };
    const ci = courseInfo(metaMap, 'Morning', 'Doxycycline', TODAY);
    expect(ci).toEqual({ start: '2026-07-01', days: 10, dayNum: 8, expired: false });
  });
  it('flags expired once past the course length', () => {
    const metaMap: HabitMetaMap = { 'morning|Doxycycline': { course_start: '2026-06-01', course_days: 10 } };
    const ci = courseInfo(metaMap, 'Morning', 'Doxycycline', TODAY);
    expect(ci?.expired).toBe(true);
  });
  it('is null for a habit with no course meta', () => {
    expect(courseInfo({}, 'Morning', 'Kefir', TODAY)).toBeNull();
  });
});

describe('showsInDaily', () => {
  const cfg: CadenceConfig = { grace_days: 1 };
  it('a plain daily habit always shows', () => {
    expect(showsInDaily('Morning', 'Kefir', {}, {}, TODAY, cfg)).toBe(true);
  });
  it('a retired habit never shows', () => {
    const map: HabitCadenceMap = { 'morning|Kefir': { stage: 'retired' } };
    expect(showsInDaily('Morning', 'Kefir', map, {}, TODAY, cfg)).toBe(false);
  });
  it('a graduated habit shows only on its spot-check day', () => {
    const dueToday: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: TODAY } };
    const notDue: HabitCadenceMap = { 'morning|Kefir': { stage: 'weekly', next_check: '2026-07-20' } };
    expect(showsInDaily('Morning', 'Kefir', dueToday, {}, TODAY, cfg)).toBe(true);
    expect(showsInDaily('Morning', 'Kefir', notDue, {}, TODAY, cfg)).toBe(false);
  });
  it('an expired course habit never shows, even if otherwise plain-daily', () => {
    const metaMap: HabitMetaMap = { 'morning|Doxycycline': { course_start: '2026-01-01', course_days: 5 } };
    expect(showsInDaily('Morning', 'Doxycycline', {}, metaMap, TODAY, cfg)).toBe(false);
  });
});

describe('habitSectionDefs', () => {
  it('falls back to canonical names when HABITS.md has no matching section', () => {
    expect(habitSectionDefs([])).toEqual([
      { label: 'Morning', name: 'Morning' },
      { label: 'Midday', name: 'Midday' },
      { label: 'Evening', name: 'Evening / Night' },
    ]);
  });
  it('picks up actual section names case-insensitively', () => {
    const habits: HabitSection[] = [
      { name: 'Morning', items: [] },
      { name: 'Midday', items: [] },
      { name: 'Night', items: [] },
    ];
    expect(habitSectionDefs(habits)).toEqual([
      { label: 'Morning', name: 'Morning' },
      { label: 'Midday', name: 'Midday' },
      { label: 'Evening', name: 'Night' },
    ]);
  });
});

describe('pickTimeSegment', () => {
  it('mirrors server.py: [5,11) morning, [11,18) afternoon, else evening', () => {
    expect(pickTimeSegment(4.9)).toBe('evening');
    expect(pickTimeSegment(0)).toBe('evening');
    expect(pickTimeSegment(5)).toBe('morning');
    expect(pickTimeSegment(10.99)).toBe('morning');
    expect(pickTimeSegment(11)).toBe('afternoon');
    expect(pickTimeSegment(17.99)).toBe('afternoon');
    expect(pickTimeSegment(18)).toBe('evening');
    expect(pickTimeSegment(23.5)).toBe('evening');
  });
});

describe('habitStartLabel', () => {
  it('labels today, 1 day, and N days', () => {
    expect(habitStartLabel({ Kefir: TODAY }, 'Kefir', TODAY)).toBe('today · ');
    expect(habitStartLabel({ Kefir: '2026-07-07' }, 'Kefir', TODAY)).toBe('1d · ');
    expect(habitStartLabel({ Kefir: '2026-06-08' }, 'Kefir', TODAY)).toBe('30d · ');
  });
  it('is empty when the habit has no recorded start', () => {
    expect(habitStartLabel({}, 'Kefir', TODAY)).toBe('');
  });
});

describe('dailySectionViews', () => {
  const habits: HabitSection[] = [
    {
      name: 'Morning',
      items: [
        { text: 'Water upon waking', done: false },
        { text: 'Kefir', done: false },
      ],
    },
    { name: 'Midday', items: [{ text: 'Pre-meal reset', done: false }] },
    { name: 'Weekly', items: [{ text: 'Building toward: run a 5k', done: false }] },
  ];

  it('only returns sections matching the selected segment, dropping non-daily sections entirely', () => {
    const views = dailySectionViews(habits, 'morning', [], {}, {}, {}, {}, TODAY);
    expect(views).toHaveLength(1);
    expect(views[0].sectionName).toBe('Morning');
    expect(views[0].items).toEqual(['Water upon waking', 'Kefir']);
  });

  it('filters out hidden items and items not showsInDaily', () => {
    const cadenceMap: HabitCadenceMap = { 'morning|Kefir': { stage: 'retired' } };
    const views = dailySectionViews(habits, 'morning', ['Water upon waking'], cadenceMap, {}, {}, {}, TODAY);
    expect(views).toHaveLength(0); // both items filtered -> section dropped
  });

  it('marks allDone when every visible item is logged today', () => {
    const log8: HabitsLog = { [TODAY]: { 'morning|Water upon waking': true, 'morning|Kefir': true } };
    const views = dailySectionViews(habits, 'morning', [], {}, {}, log8, {}, TODAY);
    expect(views[0].allDone).toBe(true);
  });

  it('a section with zero visible items after filtering does not appear at all', () => {
    const views = dailySectionViews(habits, 'evening', [], {}, {}, {}, {}, TODAY);
    expect(views).toEqual([]);
  });
});

describe('habitsReadyToGraduate', () => {
  it('collects candidates across daily sections only, skipping hidden and already-graduated', () => {
    const habits: HabitSection[] = [
      { name: 'Morning', items: [{ text: 'Kefir', done: false }, { text: 'Hidden habit', done: false }] },
      { name: 'Weekly', items: [{ text: 'Not a daily section', done: false }] },
    ];
    const cfg: CadenceConfig = { graduate_count: 1, graduate_recent: [1, 1] };
    const l: HabitsLog = { [TODAY]: { 'morning|Kefir': true, 'morning|Hidden habit': true, 'weekly|Not a daily section': true } };
    const out = habitsReadyToGraduate(habits, ['Hidden habit'], {}, {}, l, cfg, TODAY);
    expect(out).toEqual([{ section: 'Morning', item: 'Kefir' }]);
  });
});

describe('isGradSnoozed', () => {
  it('is snoozed while the stored date is in the future', () => {
    const map = { 'morning|Kefir': '2026-07-15' };
    expect(isGradSnoozed(map, 'Morning', 'Kefir', TODAY)).toBe(true);
  });
  it('is not snoozed once the date has passed or arrived', () => {
    const map = { 'morning|Kefir': TODAY };
    expect(isGradSnoozed(map, 'Morning', 'Kefir', TODAY)).toBe(false);
  });
  it('is not snoozed with no entry', () => {
    expect(isGradSnoozed({}, 'Morning', 'Kefir', TODAY)).toBe(false);
  });
});
