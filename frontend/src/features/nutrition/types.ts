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
  /** Foods whose figure is a package label's (USDA Branded Foods), not a lab measurement. */
  labelled?: string[];
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
  /** How she typed the amount ("1.5 cup"); grams stay the number that's counted. */
  measure?: string;
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
  /** Each nutrient's marker: whether the body stores it (nutrient_storage.py). */
  storage: Record<string, { kind: StorageKind; label: string }>;
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

/** Whether the body keeps a store of a nutrient — the ODS sheet's reading (nutrient_storage.py). */
export type StorageKind = 'stores' | 'steady' | 'unclear' | 'unsourced';

/** What the ODS sheet says about the body storing one nutrient, with its sentences word for word. */
export interface NutrientStorage {
  key: string;
  kind: StorageKind;
  label: string;
  summary: string | null;
  lasts: string | null;
  quotes: string[];
  unverified: string[];
  average: string | null;
  sheet: NutrientFacts['sheet'];
}

export interface NutrientDetail {
  row: NutrientRow;
  sexes: Sex[];
  facts: NutrientFacts;
  storage: NutrientStorage;
}

/** A food she's starred as one she's interested in eating. */
export interface HighlightedFood {
  fdc_id: number;
  description: string;
  added: string;
}

export interface FdcFood {
  fdc_id: number;
  /** label_photo = her own product, read by AI off a label photo and checked by her (label_products.py);
   *  open_food_facts = a local copy of a crowd-sourced Open Food Facts product (openfoodfacts.py). */
  data_type: 'foundation_food' | 'sr_legacy_food' | 'survey_fndds_food' | 'branded_food' | 'label_photo' | 'open_food_facts';
  description: string;
  category: string | null;
}

/** What to add, from her starred foods (nutrition.py `plan_additions`). */
export interface NutritionPlan {
  foods: {
    fdc_id: number;
    label: string;
    /** The average day's grams: daily_grams + weekly_grams / 7. */
    grams: number;
    /** Eaten every day. */
    daily_grams: number;
    /** Eaten over the week on top of that, in times_a_week sittings of portion_grams. */
    weekly_grams: number;
    portion_grams: number;
    times_a_week: number;
  }[];
  nutrients: {
    key: string;
    unit: string | null;
    /** 'week' for nutrients the body stores (judged on the week's average); 'day' for the rest. */
    judged: 'day' | 'week';
    now: number;
    /** What it's judged on: the ordinary day, or the week's average. */
    after: number;
    /** The heaviest day, with a weekly sitting eaten. */
    peak: number;
    target: number | null;
    limit: number | null;
    closed: boolean;
    /** Starred foods USDA has no figure for here; the plan counts them as giving none. */
    unknown_in: string[];
  }[];
  added_energy: number | null;
  /** Ceilings the day is already past; adding food can't fix those. */
  already_over: string[];
  cap_grams: number;
  energy_cap: number | null;
}

/** Grams in one cup / tbsp / egg… of a food (measures.py): USDA's own weight, or worked out by NIST's volumes. */
export interface Measure {
  /** cup, tbsp, tsp, floz, oz, or a count word like large / clove. */
  unit: string;
  label: string;
  grams: number;
  kind: 'usda' | 'derived';
  source: string;
  url: string;
}

/** A packaged product from USDA Branded Foods: the maker's label, found by name, brand or barcode (fdcdb.py). */
export interface PackagedFood extends FdcFood {
  gtin_upc: string;
  brand_owner: string | null;
  brand_name: string | null;
  serving_size: number | null;
  /** 'g' or 'ml' (or another unit as printed); only a serving in g becomes a gram weight. */
  serving_size_unit: string | null;
  household_serving: string | null;
  /** How many nutrients the label gives — usually 10–15 of the ~30 tracked. */
  nutrient_count: number;
}

/** One figure off a label photo, per serving as printed (label_products.clean_draft). */
export interface LabelFigure {
  amount: number | null;
  /** The unit it's stored in: kcal, g, mg or mcg. */
  unit: string;
  printed_unit?: string;
  dv_percent?: number | null;
}

/** What the AI read off a label photo, for her to check before saving. */
export interface LabelDraft {
  name: string;
  brand: string;
  barcode: string;
  serving_text: string;
  serving_amount: number | null;
  serving_unit: 'g' | 'ml';
  ingredients: string;
  nutrients: Record<string, LabelFigure>;
  unreadable: string[];
  notes: string;
}

/** One row of a Nutrition Facts panel; core rows are on every US label. */
export interface LabelField {
  key: string;
  words: string;
  unit: string;
  core: boolean;
}

export interface LabelJob {
  status: 'reading' | 'ready' | 'failed' | 'missing';
  draft?: LabelDraft;
  fields?: LabelField[];
  error?: string | null;
}
