/**
 * visibility.ts — which source ids are allowed on the map, or null for
 * "show all". Active filters STACK (intersect): transparency chip ∩ traced
 * recipe ∩ one food's sources ∩ single-item pick. So "partial" narrows the
 * map to partial sources, and then clicking a row drills into that one within
 * the chip's filter.
 */
import { txOf } from './axes';
import { ecoRecipeSourceIds, ecoSourcesForFood } from './ecoMatch';
import type { EcoRecipe, EcoSource, Transparency } from './types';

export function computeVisibleIds(
  sources: EcoSource[],
  txFilter: Transparency | '' | null,
  recipe: EcoRecipe | null,
  soloId: string | null,
  foodId: number | null = null,
): Set<string> | null {
  let ids: Set<string> | null = null; // null = unconstrained
  const intersect = (set: Set<string>) => {
    ids = ids ? new Set([...ids].filter((x) => set.has(x))) : set;
  };
  if (txFilter) {
    intersect(new Set(sources.filter((s) => txOf(s) === txFilter).map((s) => s.id)));
  }
  if (recipe) intersect(ecoRecipeSourceIds(recipe, sources));
  if (foodId != null) intersect(new Set(ecoSourcesForFood(foodId, sources).map((s) => s.id)));
  if (soloId) intersect(new Set([soloId]));
  return ids;
}
