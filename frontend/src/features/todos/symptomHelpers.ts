import type { HealthDay, SymptomDefinitions } from './types';

/** Column key + display label — port of health.js's `symptoms` list. */
export interface SymptomFieldDef {
  key: string;
  label: string;
}

export const SYMPTOM_FIELDS: SymptomFieldDef[] = [
  { key: 'nose_congestion', label: 'Nose Congestion' },
  { key: 'brain_fog', label: 'Brain Fog' },
  { key: 'abdominal_pain', label: 'Abdominal Pain' },
  { key: 'hand_pain', label: 'Hand Pain' },
  { key: 'headache', label: 'Headache' },
  { key: 'energy', label: 'Energy' },
];

export const SYMPTOM_LEVELS = [0, 1, 2, 3] as const;

const GENERIC_TIPS = ['None', 'Mild', 'Moderate', 'Bad'];
const ENERGY_TIPS = ['Crashed', 'Low', 'Okay', 'Great'];

/**
 * Whether symptoms were logged for `date` — port of health.js's
 * todaySymptomsDone(): a health_data row exists for the date with a non-null
 * energy. Energy 0 ("Crashed") still counts as logged, so the check must be
 * against null/undefined, not falsiness.
 */
export function symptomsLoggedOn(healthData: HealthDay[] | undefined, date: string): boolean {
  const row = (healthData || []).find((d) => d.date === date);
  return !!row && row.energy !== null && row.energy !== undefined;
}

/** The user's custom definition for a symptom level, or the generic fallback
 * (port of health.js symptomTip). */
export function symptomTip(defs: SymptomDefinitions | undefined, col: string, level: number): string {
  const custom = defs?.[col]?.[String(level)];
  if (custom) return custom;
  const generic = col === 'energy' ? ENERGY_TIPS : GENERIC_TIPS;
  return generic[level] || '';
}
