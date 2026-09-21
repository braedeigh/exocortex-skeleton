/** Pure logic for the symptom dot grid + per-day editor — port of overview.js.
 * symptomTip lived in features/todos while the dashboard had a symptom
 * check-in card; that card is gone, so it lives here with its only readers
 * (this file's dotInfo and DayEditor). */
import type { BodyHealthDay, SymptomDefinitions } from './types';

const GENERIC_TIPS = ['None', 'Mild', 'Moderate', 'Bad'];
const ENERGY_TIPS = ['Crashed', 'Low', 'Okay', 'Great'];

/** The owner's custom definition for a symptom level, or the generic fallback
 * (port of health.js symptomTip). Energy has its own scale, where 0 is the bad
 * end rather than the good one. */
export function symptomTip(defs: SymptomDefinitions | undefined, col: string, level: number): string {
  const custom = defs?.[col]?.[String(level)];
  if (custom) return custom;
  const generic = col === 'energy' ? ENERGY_TIPS : GENERIC_TIPS;
  return generic[level] || '';
}

/** "No data" dot color (overview.js `gray`). */
export const GRID_GRAY = '#ddd';

export type MetricKind = 'energy' | 'symptom' | 'toggle';

export interface GridMetric {
  name: string;
  /** health_data column. */
  key: string;
  kind: MetricKind;
}

/** Grid rows, in the old render order (energy on top, nasal spray last). */
export const GRID_METRICS: GridMetric[] = [
  { name: 'Energy', key: 'energy', kind: 'energy' },
  { name: 'Nose', key: 'nose_congestion', kind: 'symptom' },
  { name: 'Brain Fog', key: 'brain_fog', kind: 'symptom' },
  { name: 'Abdomen', key: 'abdominal_pain', kind: 'symptom' },
  { name: 'Hands', key: 'hand_pain', kind: 'symptom' },
  { name: 'Headache', key: 'headache', kind: 'symptom' },
  { name: 'Nasal spray', key: 'nose_spray', kind: 'toggle' },
];

/** Day-editor fields, in the old SYM_FIELDS order (energy first). */
export const DAY_EDITOR_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'energy', label: 'Energy' },
  { key: 'nose_congestion', label: 'Nose Congestion' },
  { key: 'brain_fog', label: 'Brain Fog' },
  { key: 'abdominal_pain', label: 'Abdominal Pain' },
  { key: 'hand_pain', label: 'Hand Pain' },
  { key: 'headache', label: 'Headache' },
];

/** Symptom-definitions editor rows + generic placeholder hints (health.js
 * SYMPTOM_DEF_FIELDS). */
export const DEFINITION_FIELDS: Array<{ key: string; label: string; hints: string[] }> = [
  { key: 'energy', label: 'Energy', hints: ['Crashed', 'Low', 'Okay', 'Great'] },
  { key: 'nose_congestion', label: 'Nose Congestion', hints: ['None', 'Mild', 'Moderate', 'Bad'] },
  { key: 'brain_fog', label: 'Brain Fog', hints: ['None', 'Mild', 'Moderate', 'Bad'] },
  { key: 'abdominal_pain', label: 'Abdominal Pain', hints: ['None', 'Mild', 'Moderate', 'Bad'] },
  { key: 'hand_pain', label: 'Hand Pain', hints: ['None', 'Mild', 'Moderate', 'Bad'] },
  { key: 'headache', label: 'Headache', hints: ['None', 'Mild', 'Moderate', 'Bad'] },
];

const ENERGY_COLORS: Record<number, string> = {
  0: 'var(--red)',
  1: 'var(--orange)',
  2: 'var(--yellow)',
  3: 'var(--green)',
};

const SYMPTOM_COLORS: Record<number, string> = {
  0: 'var(--green)',
  1: 'var(--yellow)',
  2: 'var(--orange)',
  3: 'var(--red)',
};

/**
 * Flag every day inside a 3+ consecutive-day nose-spray run (the breathing
 * flag). Port of the streak pre-compute at the top of renderDotGrid.
 */
export function noseSprayStreakFlags(days: Array<Pick<BodyHealthDay, 'nose_spray'>>): boolean[] {
  const flags = days.map(() => false);
  let run = 0;
  days.forEach((d, i) => {
    if (d.nose_spray === true) run++;
    else run = 0;
    if (run >= 3) {
      for (let j = i - run + 1; j <= i; j++) flags[j] = true;
    }
  });
  return flags;
}

export interface DotInfo {
  color: string;
  tip: string;
}

/** Color + tooltip for one grid cell — port of the per-metric `fn`s. */
export function dotInfo(
  metric: GridMetric,
  day: BodyHealthDay,
  inStreak: boolean,
  defs: SymptomDefinitions | undefined,
): DotInfo {
  if (metric.kind === 'toggle') {
    if (day.nose_spray !== true) return { color: GRID_GRAY, tip: 'Not used' };
    if (inStreak) return { color: 'var(--orange)', tip: 'Used — 3+ day streak (breathing flag)' };
    return { color: 'var(--accent)', tip: 'Used' };
  }
  const v = day[metric.key];
  if (v === null || v === undefined) return { color: GRID_GRAY, tip: 'No data' };
  const level = v as number;
  const colors = metric.kind === 'energy' ? ENERGY_COLORS : SYMPTOM_COLORS;
  return { color: colors[level] || GRID_GRAY, tip: symptomTip(defs, metric.key, level) };
}

/**
 * ["Jul", "09"] for the column header — the old code split date_short on the
 * space; fall back to deriving from the ISO date when date_short is missing
 * (e.g. an optimistically-inserted row).
 */
export function dateShortParts(day: Pick<BodyHealthDay, 'date' | 'date_short'>): [string, string] {
  if (day.date_short) {
    const [m, d] = day.date_short.split(' ');
    return [m || '', d || ''];
  }
  const dt = new Date(day.date + 'T12:00:00');
  if (Number.isNaN(dt.getTime())) return [day.date, ''];
  return [dt.toLocaleDateString('en-US', { month: 'short' }), String(dt.getDate()).padStart(2, '0')];
}

/**
 * Build the /api/symptoms payload from the day editor's selections — port of
 * saveDayEditor's score handling: fields left null/undefined (never logged,
 * never picked) stay OUT of the payload so they aren't overwritten; nose
 * spray always posts as 0/1.
 */
export function buildDaySymptomsPayload(
  selections: Record<string, number | null | undefined>,
  noseSpray: boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of DAY_EDITOR_FIELDS) {
    const v = selections[f.key];
    if (v !== null && v !== undefined) out[f.key] = v;
  }
  out.nose_spray = noseSpray ? 1 : 0;
  return out;
}

/** Drop empty strings; keep {symptom: {level: text}} — port of
 * saveSymptomDefinitions' input harvesting. */
export function cleanDefinitions(draft: SymptomDefinitions): SymptomDefinitions {
  const out: SymptomDefinitions = {};
  for (const [col, levels] of Object.entries(draft)) {
    for (const [level, text] of Object.entries(levels)) {
      const val = text.trim();
      if (!val) continue;
      (out[col] = out[col] || {})[level] = val;
    }
  }
  return out;
}
