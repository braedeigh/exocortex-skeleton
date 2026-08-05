/**
 * Which part of life each collection belongs to.
 *
 * This is a judgement call, not a fact derivable from the data — it exists so
 * the map groups into something readable instead of 50 alphabetical rows.
 * **Edit it freely**: anything not listed falls into 'Other', which is a
 * visible prompt to file it rather than a silent default.
 *
 * Order here is the order the groups appear on the map.
 */

export const DOMAIN_ORDER = [
  'Body & practice',
  'Food & kitchen',
  'Money',
  'Home & things',
  'Mind & work',
  'The app itself',
  'Other',
] as const;

export type Domain = (typeof DOMAIN_ORDER)[number];

const ASSIGNMENTS: Record<string, Domain> = {
  // Body & practice
  habits_log: 'Body & practice',
  habit_cadence: 'Body & practice',
  habit_meta: 'Body & practice',
  habit_settings: 'Body & practice',
  habit_start_dates: 'Body & practice',
  streaks: 'Body & practice',
  meditation_log: 'Body & practice',
  meditation_notes: 'Body & practice',
  movement: 'Body & practice',
  runs: 'Body & practice',
  supplements: 'Body & practice',
  symptom_definitions: 'Body & practice',
  growth_notes: 'Body & practice',
  deity_profiles: 'Body & practice',

  // Food & kitchen
  kitchen: 'Food & kitchen',
  kitchen_trips: 'Food & kitchen',
  recipes: 'Food & kitchen',
  meal_defaults: 'Food & kitchen',
  meal_notes: 'Food & kitchen',
  grocery_trips: 'Food & kitchen',
  grocery_item_rules: 'Food & kitchen',
  food_tests: 'Food & kitchen',
  test_queue: 'Food & kitchen',
  active_inventory: 'Food & kitchen',

  // Money
  expenses: 'Money',
  expense_receipts: 'Money',
  budget: 'Money',
  subscriptions: 'Money',
  tax_setaside: 'Money',
  merchant_categories: 'Money',
  merchant_labels: 'Money',
  buy_list: 'Money',

  // Home & things
  housing: 'Home & things',
  car_maintenance: 'Home & things',
  car_notes: 'Home & things',
  places: 'Home & things',
  media: 'Home & things',
  ecosystem: 'Home & things',
  ecosystem_config: 'Home & things',

  // Mind & work
  research: 'Mind & work',
  research_vectors: 'Mind & work',
  annotations: 'Mind & work',
  archivals: 'Mind & work',
  idea_notes: 'Mind & work',
  priority_notes: 'Mind & work',
  contacts: 'Mind & work',
  shrike_applied: 'Mind & work',

  // The app itself — plumbing rather than life
  dev_notes: 'The app itself',
  activity_log: 'The app itself',
  feature_usage: 'The app itself',
  theme_settings: 'The app itself',
  scheduled_prompts: 'The app itself',
  reminders: 'The app itself',
};

export function domainOf(collection: string): Domain {
  return ASSIGNMENTS[collection] ?? 'Other';
}
