/**
 * nutrientMath.ts — the small decisions the Nutrients page makes about each
 * row: which group it sits in, how its number is written, and how far along
 * its bar is. Kept apart from the page so they're tested
 * (nutrientMath.test.ts).
 *
 * Touches: ./types.ts; read by ./NutritionPage.tsx and ./NutrientPage.tsx.
 */
import type { FdcFood, Judgement, NutrientRow, NutrientStatus } from './types';

// The short tag each USDA dataset shows beside a food's name.
export const DATASET_TAGS: Record<FdcFood['data_type'], string> = {
  foundation_food: 'Foundation',
  sr_legacy_food: 'SR',
  survey_fndds_food: 'FNDDS',
};

export type RowGroup = 'over' | 'under' | 'met' | 'untargeted';

export const GROUP_TITLES: Record<RowGroup, string> = {
  over: 'Over an upper limit',
  under: 'Below target',
  met: 'Target met',
  untargeted: 'No daily target',
};

// Pick a row's group: the most urgent status any sex shown has.
// Over beats under beats met — a row under for one sex and met for the other
// sits under "Below target", so a gap never hides behind the other column.
export function groupOf(row: NutrientRow): RowGroup {
  const statuses = Object.values(row.by_sex).map((judgement) => judgement?.status as NutrientStatus);
  if (statuses.includes('over')) return 'over';
  if (statuses.includes('under')) return 'under';
  if (statuses.includes('met')) return 'met';
  return 'untargeted';
}

// Group the rows, in the page's order, dropping empty groups.
export function groupRows(rows: NutrientRow[]): { group: RowGroup; rows: NutrientRow[] }[] {
  const order: RowGroup[] = ['over', 'under', 'met', 'untargeted'];
  return order
    .map((group) => ({ group, rows: rows.filter((row) => groupOf(row) === group) }))
    .filter((entry) => entry.rows.length);
}

// Write an amount with sensible digits: 1,945 · 17.7 · 2.4 · 0.45.
export function formatAmount(value: number): string {
  const size = Math.abs(value);
  if (size >= 100) return Math.round(value).toLocaleString('en-US');
  if (size >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

// How full a row's bar is, as a share of its target, capped at 1.5 (150%).
export function barShare(amount: number, judgement: Judgement | undefined): number | null {
  const target = judgement?.target?.value;
  if (!target) return null;
  return Math.min(amount / target, 1.5);
}
