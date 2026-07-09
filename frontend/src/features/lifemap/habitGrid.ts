/**
 * habitGrid.ts — pure list-shaping for the Life Map habit tracker card,
 * ported from renderHabitTracker in static/js/habits.js. Cadence/course math
 * itself comes from features/habits/habitMath (read-only import).
 */
import { courseInfo, habitCadence } from '../habits/habitMath';
import type { CourseInfo } from '../habits/habitMath';
import type { HabitCadenceEntry, HabitCadenceMap, HabitMetaMap, HabitSection } from '../habits/types';
import { addDaysISO } from './calendarMath';

export interface WeeklySection {
  name: string;
  items: string[];
}

export interface SplitSections {
  allMorning: string[];
  allMidday: string[];
  allNight: string[];
  /** "Weekly"/"Recurring"/"Trying to add" sections → the Building next block. */
  weeklySections: WeeklySection[];
  weeklyGoals: string[];
  /** Actual HABITS.md section names for the three daily slots. */
  sectionNames: { morning: string; midday: string; night: string };
}

const WEEKLY_NAMES = ['weekly', 'recurring', 'trying to add'];

export function splitHabitSections(habits: HabitSection[] | null | undefined): SplitSections {
  const out: SplitSections = {
    allMorning: [],
    allMidday: [],
    allNight: [],
    weeklySections: [],
    weeklyGoals: [],
    sectionNames: { morning: 'Morning', midday: 'Midday', night: 'Evening / Night' },
  };
  for (const section of habits || []) {
    const n = section.name.toLowerCase();
    const items = section.items.map((i) => i.text);
    if (n === 'morning') {
      out.allMorning.push(...items);
      out.sectionNames.morning = section.name;
    } else if (n === 'midday') {
      out.allMidday.push(...items);
      out.sectionNames.midday = section.name;
    } else if (n === 'night' || n === 'evening / night') {
      out.allNight.push(...items);
      out.sectionNames.night = section.name;
    } else if (WEEKLY_NAMES.includes(n)) {
      out.weeklySections.push({ name: section.name, items });
      out.weeklyGoals.push(...items);
    }
  }
  return out;
}

/** Habits shown in the daily dot grid for one section: hidden, graduated
 * (any cadence entry) and expired-course habits are filtered out. */
export function gridHabits(
  all: string[],
  sectionName: string,
  hidden: string[] | null | undefined,
  cadenceMap: HabitCadenceMap | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  todayISO: string,
): string[] {
  const hiddenList = hidden || [];
  return all.filter((h) => {
    if (hiddenList.includes(h)) return false;
    if (habitCadence(cadenceMap, sectionName, h)) return false;
    const ci = courseInfo(metaMap, sectionName, h, todayISO);
    return !(ci && ci.expired);
  });
}

/** Every section a habit can be moved into (drives the move-to-section menu). */
export function moveTargets(split: SplitSections): string[] {
  return [
    split.sectionNames.morning,
    split.sectionNames.midday,
    split.sectionNames.night,
    ...split.weeklySections.map((s) => s.name),
  ];
}

export interface CadenceListEntry {
  section: string;
  item: string;
  c: HabitCadenceEntry;
}

export interface CadenceLists {
  graduated: CadenceListEntry[];
  retired: CadenceListEntry[];
}

/** Habits on the cadence ladder, split into active (weekly/monthly) vs retired. */
export function cadenceLists(
  habits: HabitSection[] | null | undefined,
  cadenceMap: HabitCadenceMap | null | undefined,
): CadenceLists {
  const graduated: CadenceListEntry[] = [];
  const retired: CadenceListEntry[] = [];
  for (const section of habits || []) {
    for (const it of section.items) {
      const item = it.text;
      const c = habitCadence(cadenceMap, section.name, item);
      if (!c) continue;
      if (c.stage === 'retired') retired.push({ section: section.name, item, c });
      else if (c.stage === 'weekly' || c.stage === 'monthly') graduated.push({ section: section.name, item, c });
    }
  }
  return { graduated, retired };
}

export interface FinishedCourse {
  section: string;
  item: string;
  ci: CourseInfo;
  /** ISO date the course ended (start + days - 1). */
  endISO: string;
}

/** Expired time-limited habits, deduped by item (a course in AM+PM is one
 * finished course) — the "Finished courses" block. */
export function finishedCourses(
  habits: HabitSection[] | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  todayISO: string,
): FinishedCourse[] {
  const out: FinishedCourse[] = [];
  const shown = new Set<string>();
  for (const section of habits || []) {
    for (const it of section.items) {
      const item = it.text;
      const ci = courseInfo(metaMap, section.name, item, todayISO);
      if (!ci || !ci.expired) continue;
      if (shown.has(item)) continue;
      shown.add(item);
      out.push({ section: section.name, item, ci, endISO: addDaysISO(ci.start, ci.days - 1) });
    }
  }
  return out;
}

/** Which sections a habit text currently lives in (habits.js _habitSectionsOf). */
export function habitSectionsOf(habits: HabitSection[] | null | undefined, item: string): string[] {
  return (habits || []).filter((s) => s.items.some((i) => i.text === item)).map((s) => s.name);
}
