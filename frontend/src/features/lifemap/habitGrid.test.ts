import { describe, expect, it } from 'vitest';
import { cadenceLists, finishedCourses, gridHabits, habitSectionsOf, moveTargets, splitHabitSections } from './habitGrid';
import type { HabitCadenceMap, HabitMetaMap, HabitSection } from '../habits/types';
import { habitKey } from '../habits/habitMath';

function sec(name: string, items: string[]): HabitSection {
  return { name, items: items.map((text) => ({ text, done: false })) };
}

const HABITS: HabitSection[] = [
  sec('Morning', ['Meds', 'Stretch']),
  sec('Midday', ['Walk']),
  sec('Evening / Night', ['Journal', 'Doxycycline']),
  sec('Trying to add', ['Run 3x']),
];

describe('splitHabitSections', () => {
  it('routes sections into the three daily slots + Building next', () => {
    const s = splitHabitSections(HABITS);
    expect(s.allMorning).toEqual(['Meds', 'Stretch']);
    expect(s.allMidday).toEqual(['Walk']);
    expect(s.allNight).toEqual(['Journal', 'Doxycycline']);
    expect(s.weeklyGoals).toEqual(['Run 3x']);
    expect(s.sectionNames).toEqual({ morning: 'Morning', midday: 'Midday', night: 'Evening / Night' });
  });

  it('falls back to canonical section names when a slot is missing', () => {
    const s = splitHabitSections([sec('Morning', ['A'])]);
    expect(s.sectionNames.night).toBe('Evening / Night');
  });
});

describe('gridHabits', () => {
  it('filters hidden, graduated and expired-course habits', () => {
    const cadence: HabitCadenceMap = { [habitKey('Morning', 'Stretch')]: { stage: 'weekly' } };
    const meta: HabitMetaMap = {
      [habitKey('Evening / Night', 'Doxycycline')]: { course_start: '2026-06-01', course_days: 10 },
    };
    expect(gridHabits(['Meds', 'Stretch'], 'Morning', ['Meds'], cadence, meta, '2026-07-09')).toEqual([]);
    // Doxy's 10-day course ended June 10 -> expired -> filtered.
    expect(gridHabits(['Journal', 'Doxycycline'], 'Evening / Night', [], cadence, meta, '2026-07-09')).toEqual([
      'Journal',
    ]);
    // Mid-course it still shows.
    expect(gridHabits(['Doxycycline'], 'Evening / Night', [], cadence, meta, '2026-06-05')).toEqual(['Doxycycline']);
  });
});

describe('moveTargets', () => {
  it('offers the three daily sections plus each building section', () => {
    expect(moveTargets(splitHabitSections(HABITS))).toEqual([
      'Morning',
      'Midday',
      'Evening / Night',
      'Trying to add',
    ]);
  });
});

describe('cadenceLists', () => {
  it('splits graduated vs retired', () => {
    const cadence: HabitCadenceMap = {
      [habitKey('Morning', 'Meds')]: { stage: 'weekly', passes: 2 },
      [habitKey('Morning', 'Stretch')]: { stage: 'retired' },
    };
    const { graduated, retired } = cadenceLists(HABITS, cadence);
    expect(graduated).toHaveLength(1);
    expect(graduated[0]).toMatchObject({ section: 'Morning', item: 'Meds' });
    expect(retired).toHaveLength(1);
    expect(retired[0].item).toBe('Stretch');
  });
});

describe('finishedCourses', () => {
  it('dedupes by item and computes the end date', () => {
    const habits = [sec('Morning', ['Doxycycline']), sec('Evening / Night', ['Doxycycline'])];
    const meta: HabitMetaMap = {
      [habitKey('Morning', 'Doxycycline')]: { course_start: '2026-06-01', course_days: 10 },
      [habitKey('Evening / Night', 'Doxycycline')]: { course_start: '2026-06-01', course_days: 10 },
    };
    const done = finishedCourses(habits, meta, '2026-07-09');
    expect(done).toHaveLength(1);
    expect(done[0].endISO).toBe('2026-06-10');
  });

  it('excludes still-running courses', () => {
    const meta: HabitMetaMap = {
      [habitKey('Morning', 'Doxycycline')]: { course_start: '2026-07-01', course_days: 30 },
    };
    expect(finishedCourses([sec('Morning', ['Doxycycline'])], meta, '2026-07-09')).toEqual([]);
  });
});

describe('habitSectionsOf', () => {
  it('lists every section containing the habit text', () => {
    const habits = [sec('Morning', ['Doxycycline']), sec('Evening / Night', ['Doxycycline', 'Journal'])];
    expect(habitSectionsOf(habits, 'Doxycycline')).toEqual(['Morning', 'Evening / Night']);
    expect(habitSectionsOf(habits, 'Nope')).toEqual([]);
  });
});
