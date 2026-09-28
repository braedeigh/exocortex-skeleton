/**
 * nutrientMath.ts — the small decisions the Nutrients page makes about each
 * row: which group it sits in, how its number is written, and how far along
 * its bar is, where a food's USDA page is, and what each of her foods gives
 * her (the day's totals turned around: food by food instead of nutrient by
 * nutrient). Kept apart from the page so
 * they're tested (nutrientMath.test.ts).
 *
 * Touches: ./types.ts; read by ./NutritionPage.tsx and ./NutrientPage.tsx.
 */
import type { FdcFood, Judgement, NutrientRow, NutrientStatus, Sex } from './types';

// The short tag each USDA dataset shows beside a food's name.
export const DATASET_TAGS: Record<FdcFood['data_type'], string> = {
  foundation_food: 'Foundation',
  sr_legacy_food: 'SR',
  survey_fndds_food: 'FNDDS',
  branded_food: 'Label',
  label_photo: 'Your label',
  open_food_facts: 'Open Food Facts',
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

// Link a food to its source: its own page on USDA FoodData Central, by FDC id.
export function fdcFoodUrl(fdcId: number): string {
  // A product of her own (a label photo, or a copy from Open Food Facts) has a negative id and no USDA
  // page: link where its figures came from instead — the photo, or its Open Food Facts page.
  if (fdcId < 0) return `/api/nutrition/label-products/${-fdcId}/source`;
  return `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`;
}

// The target a row is measured against: the higher floor of the sexes shown, so
// "both" never reads as met when one of them isn't.
export function dayTarget(row: NutrientRow, sexes: Sex[]): number | null {
  const floors = sexes.map((sex) => row.by_sex[sex]?.target?.value).filter((value): value is number => !!value);
  return floors.length ? Math.max(...floors) : null;
}

export interface FoodGift {
  key: string;
  label: string;
  unit: string;
  amount: number;
  /** Its share of the day's total of this nutrient, 0–1. */
  shareOfDay: number;
  /** How much of the day's target this food alone covers, in percent; null with no target. */
  percentOfTarget: number | null;
}

export interface FoodGifts {
  fdc_id: number;
  label: string;
  meals: string[];
  gifts: FoodGift[];
}

// What each of her foods gives her: the day's per-food shares, turned from
// nutrient-by-nutrient into food-by-food. Foods keep the day's order of first
// appearance; each food's nutrients are sorted by how much of the target it
// covers (the ones with no target after, biggest share of the day first).
export function foodGifts(rows: NutrientRow[], sexes: Sex[]): FoodGifts[] {
  const foods = new Map<number, FoodGifts>();
  for (const row of rows) {
    if (!row.unit || !row.amount) continue;
    const target = dayTarget(row, sexes);
    for (const share of row.by_food ?? []) {
      if (!share.amount) continue;
      const food = foods.get(share.fdc_id) ?? { fdc_id: share.fdc_id, label: share.label, meals: share.meals, gifts: [] };
      foods.set(share.fdc_id, food);
      food.gifts.push({
        key: row.key,
        label: row.label,
        unit: row.unit,
        amount: share.amount,
        shareOfDay: share.amount / row.amount,
        percentOfTarget: target ? (share.amount / target) * 100 : null,
      });
    }
  }
  for (const food of foods.values()) {
    food.gifts.sort(
      (a, b) =>
        (b.percentOfTarget ?? -1) - (a.percentOfTarget ?? -1) || b.shareOfDay - a.shareOfDay,
    );
  }
  return [...foods.values()];
}
