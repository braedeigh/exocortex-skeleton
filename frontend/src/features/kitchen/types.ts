/**
 * types.ts — shapes for GET /api/data/kitchen (server.py get_data_kitchen)
 * plus the kitchen sub-resources (parsed receipts, parsed recipes, recipes).
 * Mirrors what the old kitchen.js / kitchen-recipes.js read off the global D.
 */
import type { EcoRecipe, EcoSource } from '../ecosystem/types';

export interface GroceryItem {
  name: string;
  checked?: boolean;
  note?: string;
  category?: string;
}

export interface MealNote {
  date: string;
  text: string;
}

export interface KitchenTrip {
  date?: string;
  store?: string;
  total?: number;
  saved?: number;
  items?: number;
  line_count?: number;
}

export interface RecipeIngredient {
  item?: string;
  qty?: string;
  category?: string;
  /** '', 'usually_have', or 'n_a'. Legacy data stored these in `category`. */
  stocking_status?: string;
  note?: string;
}

export interface RecipeChoiceGroup {
  id?: string | number;
  name?: string;
  pick_n?: number;
  members?: string[];
}

export interface RecipeStepSection {
  title?: string;
  steps?: string[];
}

export interface Recipe {
  id: string;
  name?: string;
  created?: string;
  servings?: number | null;
  prep_min?: number | null;
  cook_min?: number | null;
  ingredients?: RecipeIngredient[];
  instructions?: string[];
  sections?: RecipeStepSection[];
  tags?: string[];
  notes?: string;
  my_notes?: string;
  source_url?: string | null;
  source_image?: string | null;
  parent_id?: string | null;
  is_archived?: boolean;
  choice_groups?: RecipeChoiceGroup[];
  last_picks?: Record<string, string[]>;
}

/** A map source as the kitchen reads it — the ecosystem feature's shape. */
export type { EcoSource } from '../ecosystem/types';

export interface MealPrepConfig {
  protein_rotation?: string[];
  vegetable_pool?: string[];
  always_vegetables?: string[];
  grain?: string;
  this_week?: { protein?: string; vegetables?: string[]; week_of?: string };
}

export interface MealDefaults {
  meal_prep?: MealPrepConfig;
  side_salad?: { enabled_this_week?: boolean; ingredients?: string[] };
}

export type SafetyTag = '' | 'safe' | 'suspect' | 'inflammatory';

/** Open "Request linking" requests: by food id, and by normalized name for foods filed by name. */
export interface EcoRequested {
  food_ids: number[];
  names: string[];
}

/** The kitchen slice of /api/data/kitchen the page reads. */
export interface KitchenData {
  server_date?: string;
  kitchen_list?: GroceryItem[];
  /** lowercase item name -> category */
  kitchen_known_items?: Record<string, string>;
  kitchen_purchase_counts?: Record<string, number>;
  kitchen_item_notes?: Record<string, string>;
  kitchen_pantry?: Record<string, unknown>;
  /** lowercase item name -> aisle number */
  kitchen_aisles?: Record<string, number>;
  /** lowercase item name -> YYYY-MM-DD */
  kitchen_last_bought?: Record<string, string>;
  /** lowercase item name -> 'safe' | 'suspect' | 'inflammatory' */
  kitchen_safety_tags?: Record<string, string>;
  kitchen_category_order?: string[];
  meal_notes?: MealNote[];
  kitchen_trips?: KitchenTrip[];
  recipes?: Recipe[];
  ecosystem?: { sources?: EcoSource[] };
  /** Recipes with each line resolved to its catalog food (server.py → sourcestore.map_recipes). */
  eco_recipes?: EcoRecipe[];
  /** Foods with an open "Request linking" request (source_requests) — see requestState.ts. */
  eco_requested?: EcoRequested;
  meal_defaults?: MealDefaults;
}

// --- Parsed receipts (scan → review → import) ---

export interface ParsedReceiptMeta {
  filename: string;
  photo?: string;
  store?: string;
  date?: string;
  total?: number;
  items_count?: number;
}

export interface ReceiptHeader {
  store?: string;
  date?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  saved?: number;
}

export interface ReceiptRow {
  name: string;
  qty?: number | string;
  price?: number;
  unit_price?: number | null;
  /** section name, or '@aisles' when an aisle number applies */
  category: string;
  catalog_name: string;
  include: boolean;
  aisle?: number | null;
  /** set client-side once the user confirms/edits the row */
  user_touched?: boolean;
}

// --- Parsed recipes (URL/image → review → save) ---

export interface ParsedRecipeMeta {
  filename: string;
  name?: string;
  ingredients_count?: number;
  parse_error?: string;
}

// --- Food experiments (Body-tab cards driven by kitchen.js) ---

export interface FoodTest {
  id: string;
  food: string;
  started_on: string;
  watch_window_days: number;
  results_due_on?: string;
  outcome?: string;
  outcome_at?: string;
  flare_notes?: string;
  cleared_baseline_on?: string;
  notes?: string;
}

// --- Buy organic or not (routes/food.py list-verdicts → estimatestore.py) ---

export type OrganicVerdict = 'organic' | 'some' | 'conventional' | 'open';
export type VerdictReview = 'unreviewed' | 'confirmed' | 'disputed';

/** A research verdict on the whole food — rests on measured numbers. */
export interface ResearchVerdict {
  id: number;
  verdict: OrganicVerdict;
  reasoning: string | null;
  review: VerdictReview;
  author: 'llm' | 'owner';
  grounds: number;
}

/** Something else known to get into a food, besides pesticide residue. */
export interface Contaminant {
  name: string;
  known: string;
  organic_helps: 'yes' | 'partly' | 'no' | 'unknown';
  evidence: 'established' | 'suggestive' | 'speculative';
}

/** Claude's estimate, from general knowledge rather than measurements. */
export interface OrganicEstimate {
  id: number;
  verdict: OrganicVerdict;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  qualifiers: string[];
  contaminants: Contaminant[];
  /** Ids of her research claims the estimate drew on. */
  claims: string[];
  model: string | null;
  review: VerdictReview;
  created_at: string;
}

export interface ListVerdictItem {
  name: string;
  checked: boolean;
  food_id: number | null;
  kind: string;
  research: ResearchVerdict | null;
  estimate: OrganicEstimate | null;
  /** How many claims and measurements her research tables hold about it. */
  evidence: number;
}

export interface EstimateRun {
  started: string;
  finished: string | null;
  asked: number;
  saved: string[];
  failures: { food: string; error: string }[];
}

export interface ListVerdicts {
  lens: string;
  items: ListVerdictItem[];
  pending: number;
  running: boolean;
  last_run: EstimateRun | null;
  vocab: { verdicts: Record<OrganicVerdict, string>; qualifiers: Record<string, string> };
}

/** A study behind a claim or a measurement, from her research pool. */
export interface EvidenceSource {
  id: string;
  title: string;
  url: string | null;
  stance: 'supports' | 'contradicts' | 'context' | null;
  /** The highlighted passage in the study that is the evidence, when one was marked. */
  passage?: { id: string; exact: string | null } | null;
}

/** One research claim about a food, with its figures and studies. */
export interface EvidenceClaim {
  id: string;
  text: string;
  verdict: string | null;
  author: string | null;
  reviewed: number | null;
  values: { subject: string; measure: string; amount: number | null; unit: string; basis: string | null; year: number | null; tier: string | null }[];
  sources: EvidenceSource[];
}

/** One number in the research tables about a food, with its study. */
export interface EvidenceMeasure {
  id: number;
  hazard: string;
  measure: string;
  amount: number;
  unit: string;
  year: number | null;
  measured_on: string | null;
  review: VerdictReview;
  sources: EvidenceSource[];
}

/** One food's page under Research (GET /api/food/page). */
export interface FoodPageData {
  name: string;
  food: { id: number; name: string; kind: string; category: string | null } | null;
  research: ResearchVerdict | null;
  estimate: OrganicEstimate | null;
  claims: EvidenceClaim[];
  measures: EvidenceMeasure[];
  vocab: { verdicts: Record<OrganicVerdict, string>; qualifiers: Record<string, string> };
  /** The map sources this food comes from — linked to it or to a product of it. */
  sources?: EcoSource[];
  /** origin word → what it means (sourcestore.ORIGINS) */
  origins?: Record<string, string>;
}

/** Every food, for the Foods page (GET /api/food/pages). */
export interface FoodIndexData {
  foods: {
    id: number;
    name: string;
    category: string | null;
    research: OrganicVerdict | null;
    estimate: { verdict: OrganicVerdict; confidence: string } | null;
    evidence: number;
  }[];
  verdicts: Record<OrganicVerdict, string>;
}
