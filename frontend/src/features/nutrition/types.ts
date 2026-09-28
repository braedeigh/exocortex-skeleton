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
  /** Foods whose figure came from their fill_from entry (USDA's survey data, partly estimated). */
  filled?: string[];
  /** Each of her foods' share of the amount, richest first; a food in two meals counted once. */
  by_food?: FoodShare[];
  by_sex: Partial<Record<Sex, Judgement>>;
}

export interface FoodShare {
  fdc_id: number;
  label: string;
  /** The meals of her day it's eaten in. */
  meals: string[];
  amount: number;
}

export interface NutritionReport {
  sex: SexSetting;
  age: number | null;
  sexes: Sex[];
  nutrients: NutrientRow[];
  sources: {
    composition: string;
    composition_url: string;
    targets: string;
    targets_url: string | null;
    update_2019: string;
    update_2019_url: string;
  };
}

export interface MealItem {
  label: string;
  fdc_id: number;
  grams: number;
  grams_guessed?: boolean;
  /** A second USDA food used only for the nutrients this one lacks. */
  fill_from?: number;
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

export type RankPer = '100g' | '100kcal';

/** Every USDA food ranked by one nutrient, richest first (nutrition.py `ranking`). */
export interface NutrientRanking {
  key: string;
  label: string;
  unit: string | null;
  per: RankPer;
  foods: RankedFood[];
  /** The low-histamine list every food is rated against (histamine.py); loaded false = not fetched here. */
  histamine_source: HistamineSource;
}

export type RankedFood = FdcFood & {
  amount: number;
  per_100g: number;
  kcal_per_100g: number | null;
  /** What the SIGHI list says of it, matched by name; null = not on the list. */
  histamine: HistamineRating | null;
};

export type HistamineVerdict = 'low' | 'moderate' | 'high' | 'unclear' | 'avoid';

export interface HistamineRating {
  verdict: HistamineVerdict;
  /** SIGHI's 0–3, or '?' / '-'; null for the leaflet's canned / smoked / cured rule. */
  rating: string | null;
  /** The SIGHI entry the food's name matched. */
  sighi_name: string;
  remark: string;
}

export interface HistamineSource {
  name: string;
  publisher: string;
  edition: string;
  url: string;
  leaflet_url: string;
  loaded: boolean;
}

/** A block of an NIH ODS fact sheet, word for word: a paragraph, a subheading, or a list item. */
export interface FactBlock {
  kind: 'p' | 'h3' | 'li';
  text: string;
}

/** What the NIH ODS fact sheet says about one nutrient (nutrient_facts.py). */
export interface NutrientFacts {
  key: string;
  sheet: { name: string; url: string; publisher: string; file: string; missing?: boolean } | null;
  intro: FactBlock[];
  deficiency: FactBlock[];
  at_risk: FactBlock[];
}

export interface NutrientDetail {
  row: NutrientRow;
  sexes: Sex[];
  facts: NutrientFacts;
}

/** A food she's starred as one she's interested in eating. */
export interface HighlightedFood {
  fdc_id: number;
  description: string;
  added: string;
}

export interface FdcFood {
  fdc_id: number;
  data_type: 'foundation_food' | 'sr_legacy_food' | 'survey_fndds_food';
  description: string;
  category: string | null;
}
