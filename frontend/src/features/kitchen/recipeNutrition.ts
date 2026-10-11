/**
 * recipeNutrition.ts — what each recipe gives against her daily targets, and
 * what in it she's sensitive to: the shapes routes/recipe_nutrition.py sends,
 * the calls to it, and the pure helpers the Recipes list filters and sorts by.
 *
 * The working-out lives in recipe_nutrition.py: each recipe line turned into a
 * USDA entry and a gram weight (both marked when guessed), one serving added
 * up like a meal on the Nutrients page, and flags from her food guide and the
 * SIGHI low-histamine list. RecipesSection.tsx uses the overview;
 * RecipeNutrients.tsx shows one recipe line by line.
 */
import { api } from '../../api/client';
import type { HistamineRating, HistamineSource, NutritionReport } from '../nutrition/types';
import type { Recipe } from './types';

/** What in a recipe she's sensitive to: each list holds the lines' text. */
export interface RecipeFlags {
  hurts: string[];
  unsure: string[];
  histamine_high: string[];
  histamine_moderate: string[];
  histamine_unrated: string[];
}

/** One recipe in short, for the list (GET /api/recipes/nutrition). */
export interface RecipeNutritionSummary {
  id: string;
  name: string;
  servings: number | null;
  /** 'recipe' when it has no servings, so the numbers are for the whole pot. */
  per: 'serving' | 'recipe';
  lines: number;
  /** Lines with both a USDA entry and a weight — the rest aren't in the numbers. */
  counted: number;
  /** Lines resting on a guessed entry or a weight worked out from USDA's portions. */
  guesses: number;
  nutrients: Record<string, { amount: number; unit: string | null; percent: number | null }>;
  flags: RecipeFlags;
}

export interface RecipeNutritionOverview {
  recipes: RecipeNutritionSummary[];
  /** The nutrients her usual day falls short of. */
  gaps: { key: string; label: string }[];
  histamine_source: HistamineSource;
}

/** One recipe line with its food, USDA entry and grams worked out. */
export interface RecipeNutritionLine {
  seq: number;
  text: string;
  amount: string | null;
  usually_have: boolean;
  food_id: number | null;
  food_name: string | null;
  usda: { fdc_id: number; description: string | null; confirmed: boolean } | null;
  grams: number | null;
  /** How the grams were found, or why there are none. */
  grams_how: string | null;
  grams_source: 'yours' | 'written' | 'usda_portion' | null;
  /** Her weight, set when the amount read differently — shown, not used. */
  stale_grams: { grams: number; for_amount: string | null } | null;
  safety: 'hurts' | 'unsure' | null;
  histamine: HistamineRating | null;
}

/** One recipe line by line (GET /api/recipes/<id>/nutrition). */
export interface RecipeNutritionDetail {
  id: string;
  name: string;
  servings: number | null;
  per: 'serving' | 'recipe';
  lines: RecipeNutritionLine[];
  report: NutritionReport;
  not_counted: string[];
  guesses: { usda: number; grams: number };
  flags: RecipeFlags;
  gaps: string[];
  histamine_source: HistamineSource;
}

export const OVERVIEW_KEY = ['kitchen', 'recipe-nutrition'];

export function getRecipeNutritionOverview(signal?: AbortSignal) {
  return api.get<RecipeNutritionOverview>('/api/recipes/nutrition', signal);
}

export function getRecipeNutrition(id: string, signal?: AbortSignal) {
  return api.get<RecipeNutritionDetail>(`/api/recipes/${encodeURIComponent(id)}/nutrition`, signal);
}

/** Her own weight for a line (null goes back to the worked-out one). */
export function setLineGrams(recipeId: string, line: string, grams: number | null, forAmount: string | null) {
  return api.post<{ ok: boolean }>(`/api/recipes/${encodeURIComponent(recipeId)}/grams`, {
    line,
    grams,
    for_amount: forAmount,
  });
}

/** Which USDA entry a catalog food is (null clears it back to a suggestion). */
export function setFoodUsda(foodId: number, fdcId: number | null) {
  return api.post<{ ok: boolean }>(`/api/food/foods/${foodId}/usda`, { fdc_id: fdcId });
}

// --- the list's filters -------------------------------------------------------

export interface RecipeFilters {
  /** Hide recipes with a food her guide or catalog says hurts. */
  hideHurts: boolean;
  /** Hide recipes with a line SIGHI rates high or says to avoid. */
  lowHistamine: boolean;
  /** One of her gap nutrients: sort by how much of it a serving gives. */
  goodFor: string | null;
}

const FILTERS_KEY = 'kitchen.recipeFilters';

/** The filters as last left, from localStorage; all off when unset or unreadable. */
export function readRecipeFilters(): RecipeFilters {
  const off = { hideHurts: false, lowHistamine: false, goodFor: null };
  try {
    return { ...off, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') };
  } catch {
    return off;
  }
}

export function writeRecipeFilters(filters: RecipeFilters) {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
}

/** Whether a recipe survives the filters. One with no summary yet is kept: unknown isn't a reason to hide. */
export function passesFilters(summary: RecipeNutritionSummary | undefined, filters: RecipeFilters): boolean {
  if (!summary) return true;
  if (filters.hideHurts && summary.flags.hurts.length) return false;
  if (filters.lowHistamine && summary.flags.histamine_high.length) return false;
  return true;
}

/** Recipes richest first in one nutrient, per serving; recipes with no figure keep their order, last. */
export function sortByNutrient(
  recipes: Recipe[],
  summaries: Map<string, RecipeNutritionSummary>,
  key: string,
): Recipe[] {
  const percent = (recipe: Recipe) => summaries.get(recipe.id)?.nutrients[key]?.percent ?? -1;
  return [...recipes].sort((a, b) => percent(b) - percent(a));
}

/**
 * The few numbers a recipe card shows: energy, then the chosen nutrient, then
 * her gaps a serving gives most of — e.g. ["480 kcal", "iron 27%", "folate 20%"].
 */
export function servingHighlights(
  summary: RecipeNutritionSummary,
  gaps: { key: string; label: string }[],
  goodFor: string | null,
  count = 2,
): string[] {
  const bits: string[] = [];
  const energy = summary.nutrients.energy;
  if (energy?.unit) bits.push(`${Math.round(energy.amount)} kcal`);
  const withPercent = gaps
    .map((gap) => ({ ...gap, percent: summary.nutrients[gap.key]?.percent ?? null }))
    .filter((gap) => gap.percent != null && gap.percent > 0);
  const chosen = withPercent.find((gap) => gap.key === goodFor);
  const rest = withPercent
    .filter((gap) => gap.key !== goodFor)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
    .slice(0, count);
  for (const gap of chosen ? [chosen, ...rest] : rest) bits.push(`${gap.label.toLowerCase()} ${gap.percent}%`);
  return bits;
}
