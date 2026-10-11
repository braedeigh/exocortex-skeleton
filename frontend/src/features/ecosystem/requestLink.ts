/**
 * requestLink.ts — answers "does this food already have an open request to be
 * linked?" from the `eco_requested` marker that /api/data/kitchen and
 * /api/data/ecosystem carry (owner-only; absent for public viewers).
 *
 * The marker lists food ids AND names, because a food can be requested before
 * it has an id. Names come normalized the way the server's foodstore._norm
 * does it — trimmed, lowercased, runs of spaces collapsed — so a name is
 * normalized the same way here before it's compared.
 *
 * Used by RequestLinkButton's callers (the map, the Kitchen) to set its
 * `requested` prop. Tested in requestLink.test.ts.
 */

/** The `eco_requested` payload key: open link requests, by id and by name. */
export interface EcoRequested {
  food_ids: number[];
  names: string[];
}

/** Normalize a food name the way foodstore._norm does on the server. */
export function normalizeFoodName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Check a food against the open requests — by id first, then by name. */
export function isFoodRequested(
  ecoRequested: EcoRequested | null | undefined,
  foodId: number | null,
  foodName: string,
): boolean {
  if (!ecoRequested) return false;
  if (foodId != null && ecoRequested.food_ids.includes(foodId)) return true;
  return ecoRequested.names.includes(normalizeFoodName(foodName));
}
