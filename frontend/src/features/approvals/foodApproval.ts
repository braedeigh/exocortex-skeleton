/**
 * foodApproval.ts — pure editor→commit mapping for kind "food".
 * Port of static/js/approvals/food.js: edits a semicolon-separated
 * `food_notes` string for a date and commits through POST /api/food/set
 * (replace, not append). Undo re-POSTs the previous value for that date.
 *
 * Payload contract (what the food cricket stages AND this editor reads):
 *   { date: "YYYY-MM-DD", food_notes: "item1; item2; item3" }
 */
import type { HealthDay } from '../todos/types';
import type { BuildResult } from './shared';
import { asString, findHealthRow } from './shared';
import type { JsonValue } from './types';

export interface FoodDraft {
  date: string;
  foodNotes: string;
}

export function foodDraftFromPayload(payload: Record<string, JsonValue>): FoodDraft {
  return {
    date: asString(payload.date),
    foodNotes: asString(payload.food_notes),
  };
}

/** Form state → the POST /api/food/set body. Date is required (legacy
 * focused the date input); notes may be empty — that clears the day. */
export function buildFoodSet(
  draft: FoodDraft,
): BuildResult<{ date: string; food_notes: string }> {
  const date = draft.date.trim();
  if (!date) return { ok: false, error: 'Date is required' };
  return { ok: true, value: { date, food_notes: draft.foodNotes.trim() } };
}

/**
 * The date's previous food_notes, for a REAL undo (re-POST the old value).
 * Legacy captured this from the already-loaded `window.D.health_data` before
 * the overwrite; the React editor captures it from the /api/data/today
 * snapshot the same way. '' when the day had no notes (undo then clears).
 */
export function prevFoodNotes(healthData: HealthDay[] | undefined, date: string): string {
  const row = findHealthRow(healthData, date);
  const v = row?.food_notes;
  return typeof v === 'string' && v ? v : '';
}
