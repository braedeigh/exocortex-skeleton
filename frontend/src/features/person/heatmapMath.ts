/**
 * heatmapMath.ts — pure math for the GitHub-contributions-style activity
 * heat map, ported line-for-line from static/js/person.js renderHeatmap():
 * weeks as columns (Mon=row 0 … Sun=row 6), the range padded out to whole
 * weeks, a month label on each week that starts a new month, and quartile
 * intensity binning against the busiest day. No DOM — unit-tested.
 */

import type { MentionDay } from './types';

export interface HeatCell {
  date: string;
  count: number;
}

/** One column: exactly 7 cells, Monday first. */
export type HeatWeek = HeatCell[];

export interface MonthLabel {
  /** Index into `weeks` of the column this label sits over. */
  week: number;
  /** "Jan" … "Dec". */
  label: string;
}

export interface HeatmapModel {
  weeks: HeatWeek[];
  monthLabels: MonthLabel[];
  maxCount: number;
}

/** Intensity level -> HSL lightness (person.js LEVEL_L). */
export const LEVEL_LIGHTNESS: Record<1 | 2 | 3 | 4, number> = { 1: 60, 2: 48, 3: 38, 4: 26 };

export type IntensityLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Quartile bin against the busiest day. Zero -> 0 (empty); when every
 * active day has count 1 there's nothing to grade, so all hits render at
 * full strength (level 4) — exactly the old `maxCount <= 1` branch.
 */
export function intensityBucket(count: number, maxCount: number): IntensityLevel {
  if (!count) return 0;
  if (maxCount <= 1) return 4;
  const r = count / maxCount;
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}

/**
 * CSS background for a cell: the page's empty-cell var at level 0, else the
 * person's hue at the level's lightness (person.js's inline style).
 */
export function cellBackground(count: number, maxCount: number, hue: number): string {
  const lvl = intensityBucket(count, maxCount);
  return lvl === 0 ? 'var(--p-hm-empty)' : `hsl(${hue} 70% ${LEVEL_LIGHTNESS[lvl]}%)`;
}

/** Mon=0 … Sun=6 (JS getDay is Sun=0). */
function dow(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Local YYYY-MM-DD. */
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build the whole grid from the API's sparse day list. Returns null when
 * there are no days at all (the "No activity yet." case).
 */
export function buildHeatmap(days: MentionDay[]): HeatmapModel | null {
  if (!days.length) return null;

  const counts = new Map(days.map((d) => [d.date, d.count]));
  const sortedDates = days
    .map((d) => d.date)
    .slice()
    .sort();
  // Noon-anchored so DST shifts can't move a date across midnight.
  const first = new Date(`${sortedDates[0]}T12:00:00`);
  const last = new Date(`${sortedDates[sortedDates.length - 1]}T12:00:00`);

  const start = new Date(first);
  start.setDate(start.getDate() - dow(first));
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - dow(last)));

  const maxCount = Math.max(0, ...days.map((d) => d.count || 0));

  const weeks: HeatWeek[] = [];
  const monthLabels: MonthLabel[] = [];
  let week: HeatCell[] = [];
  let prevMonth: number | null = null;
  const cur = new Date(start);
  while (cur <= end) {
    if (week.length === 0) {
      const m = cur.getMonth();
      if (m !== prevMonth) {
        monthLabels.push({
          week: weeks.length,
          label: cur.toLocaleDateString('en-US', { month: 'short' }),
        });
        prevMonth = m;
      }
    }
    const dateStr = fmt(cur);
    week.push({ date: dateStr, count: counts.get(dateStr) || 0 });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (week.length) weeks.push(week);

  return { weeks, monthLabels, maxCount };
}
