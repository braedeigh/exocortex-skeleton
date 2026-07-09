/**
 * calendarMath.ts — pure calendar/date math for the Life Map tab, ported from
 * static/js/activity.js (month grid, date map, stats) and the shared
 * last-30-days windows in habits.js/contacts.js. Everything takes an explicit
 * todayISO (server_date) — nothing reads the wall clock (mirrors the
 * habitMath.ts/reminderMath.ts contract).
 */
import type { ReminderDef } from '../todos/types';
import type { ActivityEntry, KitchenTrip, RunEntry } from './types';

export function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateAtNoon(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

export function addDaysISO(iso: string, n: number): string {
  const d = dateAtNoon(iso);
  d.setDate(d.getDate() + n);
  return fmtISO(d);
}

/** Whole days from `fromISO` back to `toISO` (both local-midday anchored). */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((dateAtNoon(fromISO).getTime() - dateAtNoon(toISO).getTime()) / 86400000);
}

/** The last `n` days ending at todayISO, oldest first — the shared window for
 * the habit dot grid and the contact calendar. */
export function lastNDays(todayISO: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDaysISO(todayISO, -i));
  return out;
}

export interface MonthGrid {
  year: number;
  /** 0-based month index. */
  month: number;
  /** e.g. "July 2026" */
  monthLabel: string;
  /** Monday-first day-of-week of the 1st (Mon=0 … Sun=6). */
  startDow: number;
  daysInMonth: number;
  /** ISO date strings for day 1..daysInMonth. */
  dates: string[];
}

/** Month grid for todayISO's month shifted by `offset` months (0 = current,
 * -1 = last month …) — activity.js renderActivityCalendar's grid math. */
export function monthGrid(todayISO: string, offset: number): MonthGrid {
  const now = dateAtNoon(todayISO);
  const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const dates: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dates.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return {
    year,
    month,
    monthLabel: firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    startDow,
    daysInMonth,
    dates,
  };
}

// --- Activity type map -------------------------------------------------------

export type DotShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'ring';

export interface ActivityTypeInfo {
  label: string;
  color: string;
  shape: DotShape;
  emoji?: string;
}

/** Shape = family (movement circle, errands square, linens diamond, meds
 * triangle, body ring); color = the individual ritual within it. Mirrors
 * core.js ACT_TYPES. */
export const ACT_TYPES: Record<string, ActivityTypeInfo> = {
  run: { label: 'Run', color: 'var(--green)', shape: 'circle' },
  kitchen: { label: 'Grocery', color: '#4A90D9', shape: 'square' },
  'laundry-sheets': { label: 'Sheets', color: '#E06060', shape: 'diamond' },
  'wash-eyemasks': { label: 'Eye masks', color: '#5BB8C9', shape: 'diamond' },
  'change-pillowcase': { label: 'Pillowcase', color: '#D4A0A0', shape: 'diamond' },
  'wash-hair': { label: 'Hair wash', color: '#8B7EC8', shape: 'circle' },
  estradiol: { label: 'Estradiol', color: '#E091C7', shape: 'triangle' },
  peptides: { label: 'Peptides', color: '#6FBF8B', shape: 'triangle' },
};

/** Fallback for D.private_act_types when the server field is absent. */
export const PRIVATE_ACT_TYPES = ['estradiol', 'peptides'];

export function privateActTypes(fromServer: string[] | null | undefined): string[] {
  return Array.isArray(fromServer) && fromServer.length ? fromServer : PRIVATE_ACT_TYPES;
}

/** Base ACT_TYPES overridden/extended by the user-managed reminder registry so
 * colors + labels stay in sync everywhere (core.js activityTypeMap). */
export function activityTypeMap(reminders: ReminderDef[] | null | undefined): Record<string, ActivityTypeInfo> {
  const map: Record<string, ActivityTypeInfo> = { ...ACT_TYPES };
  for (const r of reminders || []) {
    if (!r || !r.type) continue;
    map[r.type] = {
      label: r.label || r.type,
      color: r.color || '#9AA0B5',
      emoji: r.emoji || '',
      shape: (r.shape as DotShape) || map[r.type]?.shape || 'circle',
    };
  }
  return map;
}

// --- Date map (all activity merged per day) ----------------------------------

/** Merge runs + kitchen trips + activity_log into { "2026-03-24": ["run",
 * "kitchen"] }; `hiddenTypes` (private types in public view) never appear. */
export function buildActivityDateMap(
  runs: RunEntry[] | null | undefined,
  trips: KitchenTrip[] | null | undefined,
  activityLog: ActivityEntry[] | null | undefined,
  hiddenTypes: string[] = [],
): Record<string, string[]> {
  const dateMap: Record<string, string[]> = {};
  const add = (date: string, type: string) => {
    if (hiddenTypes.includes(type)) return;
    if (!dateMap[date]) dateMap[date] = [];
    if (!dateMap[date].includes(type)) dateMap[date].push(type);
  };
  (runs || []).forEach((r) => add(r.date, 'run'));
  (trips || []).forEach((t) => add(t.date, 'kitchen'));
  (activityLog || []).forEach((e) => add(e.date, e.type));
  return dateMap;
}

// --- Stats row -----------------------------------------------------------------

/** Monday of todayISO's week (Mon–Sun weeks, like activity.js). */
export function mondayOf(todayISO: string): string {
  const d = dateAtNoon(todayISO);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return fmtISO(d);
}

/** Runs logged this week (Mon..today inclusive). */
export function runsThisWeek(runs: RunEntry[] | null | undefined, todayISO: string): number {
  const mon = mondayOf(todayISO);
  return (runs || []).filter((r) => r.date >= mon && r.date <= todayISO).length;
}

/** Days since the most recent kitchen trip, or null when none logged. */
export function daysSinceLastTrip(trips: KitchenTrip[] | null | undefined, todayISO: string): number | null {
  const list = trips || [];
  if (!list.length) return null;
  return daysBetween(todayISO, list[list.length - 1].date);
}

/** Days since the most recent activity entry of `type`, or null when never. */
export function daysSinceLastOfType(
  entries: ActivityEntry[] | null | undefined,
  type: string,
  todayISO: string,
): number | null {
  const last = [...(entries || [])].reverse().find((e) => e.type === type);
  if (!last) return null;
  return daysBetween(todayISO, last.date);
}
