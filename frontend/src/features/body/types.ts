/** Types for the Body tab — shapes match /api/data/body (server.py get_data_body). */

export type SafetyTag = 'safe' | 'suspect' | 'inflammatory';

/** One row of server.py's load_health_data() (habits.csv), as the Body tab
 * reads it. `nose_spray` arrives as a real boolean (data_helpers.py casts it),
 * unlike the numeric SymptomPayload we *send* (bodyApi.ts). */
export interface BodyHealthDay {
  date: string;
  /** "Jul 09" — used for the dot-grid column headers. */
  date_short?: string;
  day_name?: string;
  energy?: number | null;
  nose_congestion?: number | null;
  brain_fog?: number | null;
  abdominal_pain?: number | null;
  hand_pain?: number | null;
  headache?: number | null;
  nose_spray?: boolean | null;
  food_notes?: string | null;
  [key: string]: unknown;
}

/** Hardcoded starter guide (server.py FOOD_GUIDE) — user safety tags override it. */
export interface FoodGuide {
  safe: string[];
  hurts: string[];
  unsure: string[];
  inflammatory: string[];
}

export type FoodTestOutcome = 'cleared' | 'flared';

/** One elimination-diet experiment (routes/food_test.py). */
export interface FoodTest {
  id: string;
  food: string;
  started_on: string;
  watch_window_days: number;
  results_due_on: string;
  outcome: FoodTestOutcome | null;
  outcome_at: string | null;
  flare_notes?: string;
  cleared_baseline_on: string | null;
  notes?: string;
}

/** symptom column -> level ("0".."3") -> the user's own definition text. */
export type SymptomDefinitions = Record<string, Record<string, string>>;

export interface BodyData {
  server_date: string;
  health_data?: BodyHealthDay[];
  food_guide?: FoodGuide;
  /** Kitchen catalog: item name -> category. Names are lowercase. */
  kitchen_known_items?: Record<string, string>;
  /** item name (lowercase) -> safety tag. */
  kitchen_safety_tags?: Record<string, SafetyTag>;
  /** Not included in /api/data/body today (kitchen-only fields) — typed
   * optionally so the triage sort/meta light up if the endpoint ever adds
   * them, exactly like the old page degraded without them. */
  kitchen_last_bought?: Record<string, string>;
  kitchen_purchase_counts?: Record<string, number>;
  food_tests?: FoodTest[];
  food_test_queue?: string[];
  symptom_definitions?: SymptomDefinitions;
  [key: string]: unknown;
}
