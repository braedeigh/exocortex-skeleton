/**
 * types.ts — the shapes routes/nutrition.py sends: her usual day added up
 * nutrient by nutrient (nutrition.py `report`), her meals as foods with gram
 * weights, and her settings.
 */

export type Sex = 'female' | 'male';
export type SexSetting = Sex | 'both';

export type NutrientStatus = 'under' | 'met' | 'over' | 'no_target' | 'no_data';

export interface Judgement {
  status: NutrientStatus;
  /** The floor: an RDA (firm) or AI (softer), in the total's unit. */
  target?: { value: number; kind: 'rda' | 'ai'; source: string };
  percent?: number | null;
  /** The ceiling: a UL, or sodium's CDRR; `applies_to` set when it doesn't count food. */
  limit?: { value: number; kind: 'ul' | 'cdrr'; source: string; applies_to: string | null };
}

export interface NutrientRow {
  key: string;
  label: string;
  unit: string | null;
  amount: number;
  low: number;
  high: number;
  /** Foods USDA has no figure for — the total is a floor while this isn't empty. */
  missing: string[];
  by_sex: Partial<Record<Sex, Judgement>>;
}

export interface NutritionReport {
  sex: SexSetting;
  age: number | null;
  sexes: Sex[];
  nutrients: NutrientRow[];
  sources: { composition: string; targets: string; update_2019: string };
}

export interface MealItem {
  label: string;
  fdc_id: number;
  grams: number;
  grams_guessed?: boolean;
}

export interface Meal {
  note?: string;
  items: MealItem[];
}

export interface DaySlot {
  meal: string;
  servings: number;
}

export interface NutritionDay {
  report: NutritionReport;
  meals: Record<string, Meal>;
  day: DaySlot[];
  settings: { sex: SexSetting; age: number | null };
}

export interface FdcFood {
  fdc_id: number;
  data_type: 'foundation_food' | 'sr_legacy_food';
  description: string;
  category: string | null;
}
