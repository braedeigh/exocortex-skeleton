/**
 * types.ts — shapes for GET /api/data/kitchen (server.py get_data_kitchen)
 * plus the kitchen sub-resources (parsed receipts, parsed recipes, recipes).
 * Mirrors what the old kitchen.js / kitchen-recipes.js read off the global D.
 */

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

export interface EcoSource {
  id: string;
  name?: string;
  transparency?: string;
}

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
