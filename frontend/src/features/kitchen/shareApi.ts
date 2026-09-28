/**
 * shareApi.ts — shared recipes: her calls to share and unshare, a visitor's
 * calls to open one or list them all, and the pure filters the visitor's list
 * runs in the page.
 *
 * The rules about what a visitor may see live in recipe_shares.py (an
 * allow-list); routes/recipe_share.py is the door. A visitor's age and sex
 * travel only as query parameters and are never stored — here they live in
 * the page's URL, so the list and a recipe opened from it agree.
 */
import { api } from '../../api/client';
import type { HistamineRating, HistamineSource, NutritionReport, Sex } from '../nutrition/types';

// --- her side ----------------------------------------------------------------------

/** Her open shares, by recipe id. */
export type MyShares = Record<string, { token: string; views: number; created_at: string | null }>;

export const MY_SHARES_KEY = ['kitchen', 'recipe-shares'];

export function getMyShares(signal?: AbortSignal) {
  return api.get<MyShares>('/api/recipes/shares', signal);
}

export function shareRecipe(recipeId: string) {
  return api.post<{ ok: boolean; token: string; path: string }>(`/api/recipes/${encodeURIComponent(recipeId)}/share`, {});
}

export function unshareRecipe(recipeId: string) {
  return api.post<{ ok: boolean; closed: number }>(`/api/recipes/${encodeURIComponent(recipeId)}/unshare`, {});
}

/** The whole link, as someone else would paste it. */
export function shareUrl(token: string): string {
  return `${window.location.origin}/share/r/${token}`;
}

// --- a visitor's side --------------------------------------------------------------

/** Who the numbers are for: what the visitor typed, or nothing yet. */
export interface Visitor {
  sex: Sex | 'both';
  age: number | null;
}

/** A visitor from the page's URL search: anything unreadable falls back to none given. */
export function readVisitor(search: Record<string, unknown>): Visitor {
  const sex = search.sex === 'female' || search.sex === 'male' ? search.sex : 'both';
  const age = Number(search.age);
  return { sex, age: Number.isInteger(age) && age >= 1 && age <= 120 ? age : null };
}

/** The query string that carries a visitor's age and sex. */
export function visitorQuery(visitor: Visitor, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  params.set('sex', visitor.sex);
  if (visitor.age) params.set('age', String(visitor.age));
  return params.toString();
}

export interface SharedLine {
  text: string;
  amount: string | null;
  grams: number | null;
  grams_how: string | null;
  usda: { description: string | null; confirmed: boolean } | null;
  histamine: HistamineRating | null;
}

export interface SharedFlags {
  histamine_high: string[];
  histamine_moderate: string[];
  histamine_unrated: string[];
}

/** One shared recipe (GET /api/share/r/<token>). */
export interface SharedRecipe {
  token: string;
  name: string | null;
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  source_url: string | null;
  ingredients: { item: string; qty: string; note: string }[];
  instructions: string[];
  sections: { title: string; steps: string[] }[];
  nutrition: {
    servings: number | null;
    per: 'serving' | 'recipe';
    lines: SharedLine[];
    report: NutritionReport;
    not_counted: string[];
    flags: SharedFlags;
    histamine_source: HistamineSource;
  } | null;
}

/** One shared recipe in short (GET /api/share/recipes). */
export interface SharedSummary {
  token: string;
  name: string | null;
  servings: number | null;
  per: 'serving' | 'recipe';
  views: number;
  ingredients: string[];
  lines: number;
  counted: number;
  nutrients: Record<string, { amount: number; unit: string | null; percent: number | null }>;
  flags: SharedFlags;
}

export interface SharedList {
  recipes: SharedSummary[];
  nutrients: { key: string; label: string }[];
  histamine_source: HistamineSource | null;
}

export function getShared(token: string, visitor: Visitor, count: boolean, signal?: AbortSignal) {
  const query = visitorQuery(visitor, count ? { count: '1' } : {});
  return api.get<SharedRecipe>(`/api/share/r/${encodeURIComponent(token)}?${query}`, signal);
}

export function getSharedList(visitor: Visitor, signal?: AbortSignal) {
  return api.get<SharedList>(`/api/share/recipes?${visitorQuery(visitor)}`, signal);
}

// --- the visitor's filters -----------------------------------------------------------

/** The foods a visitor typed, one per comma or line: trimmed, lowercased, blanks dropped. */
export function avoidWords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The ingredients a recipe has that the visitor avoids. A word matches an
 * ingredient it appears in as a whole word, singular or plural: "onion"
 * catches "yellow onions", "nut" doesn't catch "butternut squash".
 */
export function avoidedIn(ingredients: string[], words: string[]): string[] {
  const hits: string[] = [];
  for (const ingredient of ingredients) {
    const tokens = ingredient.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    const stems = new Set(tokens.map((token) => token.replace(/(es|s)$/, '')));
    const caught = words.some((word) => {
      const parts = word.split(/\s+/).map((part) => part.replace(/(es|s)$/, ''));
      return parts.every((part) => stems.has(part));
    });
    if (caught) hits.push(ingredient);
  }
  return hits;
}

/** Recipes richest first in one nutrient, per serving, by the visitor's own target; ones with no figure last. */
export function sortSharedBy(recipes: SharedSummary[], key: string): SharedSummary[] {
  const score = (recipe: SharedSummary) => {
    const figure = recipe.nutrients[key];
    return figure?.percent ?? (figure ? figure.amount / 1e6 : -1);
  };
  return [...recipes].sort((a, b) => score(b) - score(a));
}
