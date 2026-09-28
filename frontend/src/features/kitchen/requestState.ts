/**
 * requestState.ts — has she already asked research to trace this food?
 *
 * What this file does: answers "is there an open Request linking for this
 * food?" from the `eco_requested` block the kitchen payload carries
 * (/api/data/kitchen → { food_ids, names }). A request filed by id matches on
 * the id; one filed by a bare name (a food not in the catalog yet) matches on
 * the name, normalized the way the server's foodstore._norm does it — trimmed,
 * lowercased, runs of spaces collapsed. RecipeDetailView.tsx and the organic
 * popup (OrganicVerdict.tsx) use it to show the button as "Requested".
 */
import type { EcoRequested } from './types';

/** Normalize a food name like foodstore._norm: trim, lowercase, collapse spaces. */
export function normFoodName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isLinkRequested(
  requested: EcoRequested | undefined,
  foodId: number | null | undefined,
  foodName: string,
): boolean {
  if (!requested) return false;
  if (foodId != null && requested.food_ids.includes(foodId)) return true;
  return requested.names.includes(normFoodName(foodName));
}
