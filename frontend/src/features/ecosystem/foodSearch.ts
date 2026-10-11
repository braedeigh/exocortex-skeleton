/**
 * foodSearch.ts — the one search box at the top of every Food-area page
 * (FoodNav) and what it matches. Type "kale" once and the map, the foods
 * list, the review list, the contaminants list and the meals all narrow to
 * it; move between those pages and the words stay in the box.
 *
 * The words live in a small shared store (read with useFoodSearch), kept in
 * sessionStorage so a reload keeps them and a new tab starts empty. The rest
 * of the file is plain matching helpers, so each page filters the same way:
 * a food matches by its own name or a product's; a recipe matches by its
 * name and brings its foods along; a source matches by its name or note, by
 * a matching food it's linked to, or by a matching recipe traced through it.
 *
 * Touches: ./types.ts, ./ecoMatch.ts, ./proposals.ts. Read by FoodNav.tsx,
 * EcosystemPage.tsx, ReviewPage.tsx, ../research/FoodPage.tsx (FoodsIndex),
 * ../exposure/ContaminantPage.tsx, ../nutrition/NutritionPage.tsx.
 *
 * Prompt that produced it: "a search/filter box at the top of the /food tab
 * that lets her search for specific foods or recipes, and has that filter
 * apply across all the sections on the page (map, foods list, review, etc.)"
 */
import { useSyncExternalStore } from 'react';
import { ecoRecipeSourceIds } from './ecoMatch';
import type { EcoProposal } from './proposals';
import type { EcoFood, EcoRecipe, EcoSource } from './types';

// --- the shared words ------------------------------------------------------------

// Keep the words in one place every page subscribes to — a tiny external store.
const STORAGE_KEY = 'food-area-search';
const listeners = new Set<() => void>();
let current = readStored();

function readStored(): string {
  try {
    return typeof window === 'undefined' ? '' : (window.sessionStorage.getItem(STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

export function setFoodSearch(value: string) {
  current = value;
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or storage full: the search still works for this page view.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The words in the Food-area search box, and the setter. */
export function useFoodSearch(): [string, (value: string) => void] {
  const value = useSyncExternalStore(subscribe, () => current, () => '');
  return [value, setFoodSearch];
}

// --- matching --------------------------------------------------------------------

/** Lower-cased, trimmed words; '' means "no search, show everything". */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Does any of these texts contain the (normalized) query? */
export function textMatches(needle: string, ...texts: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return texts.some((text) => !!text && text.toLowerCase().includes(needle));
}

/** Recipes whose name matches. */
export function matchingRecipes(needle: string, recipes: EcoRecipe[]): EcoRecipe[] {
  if (!needle) return [];
  return recipes.filter((recipe) => textMatches(needle, recipe.name));
}

/** Foods that match: by their own name or a product's, or by being in a matching recipe. */
export function matchingFoodIds(needle: string, foods: EcoFood[], recipes: EcoRecipe[]): Set<number> {
  const ids = new Set<number>();
  if (!needle) return ids;
  foods.forEach((food) => {
    if (textMatches(needle, food.name, ...food.products.map((product) => product.name))) ids.add(food.id);
  });
  matchingRecipes(needle, recipes).forEach((recipe) =>
    (recipe.ingredients ?? []).forEach((line) => {
      if (line.food_id != null) ids.add(line.food_id);
    }),
  );
  return ids;
}

/** Sources that match, or null when there's no search (every source allowed). */
export function matchingSourceIds(
  needle: string,
  sources: EcoSource[],
  foods: EcoFood[],
  recipes: EcoRecipe[],
): Set<string> | null {
  if (!needle) return null;
  const foodIds = matchingFoodIds(needle, foods, recipes);
  const ids = new Set<string>();
  sources.forEach((source) => {
    const linked = (source.links ?? []).some(
      (link) => (link.food_id != null && foodIds.has(link.food_id)) || textMatches(needle, link.product_name),
    );
    if (linked || textMatches(needle, source.name, source.note)) {
      ids.add(source.id);
    }
  });
  matchingRecipes(needle, recipes).forEach((recipe) => ecoRecipeSourceIds(recipe, sources).forEach((id) => ids.add(id)));
  return ids;
}

/** A suggested source matches by its own name/summary or by the food it's for. */
export function proposalMatches(needle: string, proposal: EcoProposal, foodIds: Set<number>): boolean {
  if (!needle) return true;
  return (
    (proposal.food_id != null && foodIds.has(proposal.food_id)) ||
    textMatches(needle, proposal.name, proposal.summary, proposal.usda_commodity)
  );
}
