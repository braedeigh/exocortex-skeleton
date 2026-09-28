/**
 * api.ts — the nutrition endpoints (routes/nutrition.py) over the shared client.
 */
import { api } from '../../api/client';
import type {
  FdcFood,
  HighlightedFood,
  MealItem,
  NutrientDetail,
  NutrientRanking,
  NutritionDay,
  RankPer,
  SexSetting,
} from './types';

export function getDay(signal?: AbortSignal) {
  return api.get<NutritionDay>('/api/nutrition/day', signal);
}

/** USDA foods by name; singleOnly keeps single foods (nutrition.is_single_food). */
export function searchFoods(text: string, singleOnly: boolean, signal?: AbortSignal) {
  const query = new URLSearchParams({ q: text });
  if (singleOnly) query.set('single', '1');
  return api.get<{ foods: FdcFood[] }>(`/api/nutrition/search?${query}`, signal);
}

/**
 * Every USDA food ranked by one nutrient; lowHistamine keeps only the foods SIGHI
 * rates 0, singleOnly only single foods (nutrition.is_single_food).
 */
export function rankFoods(
  key: string,
  per: RankPer,
  words: string,
  limit: number,
  lowHistamine: boolean,
  singleOnly: boolean,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ per, q: words, limit: String(limit) });
  if (lowHistamine) query.set('histamine', 'low');
  if (singleOnly) query.set('single', '1');
  return api.get<NutrientRanking>(`/api/nutrition/rank/${encodeURIComponent(key)}?${query}`, signal);
}

export function saveMeal(name: string, items: MealItem[]) {
  return api.post<{ ok: boolean }>(`/api/nutrition/meals/${encodeURIComponent(name)}`, { items });
}

export function deleteMeal(name: string) {
  return api.delete<{ ok: boolean }>(`/api/nutrition/meals/${encodeURIComponent(name)}`);
}

/** How many of a meal she eats a day; 0 takes it out of the day but keeps it saved. */
export function saveServings(name: string, servings: number) {
  return api.post<{ ok: boolean }>(`/api/nutrition/servings/${encodeURIComponent(name)}`, { servings });
}

export function saveSettings(settings: { sex?: SexSetting; age?: number }) {
  return api.post<{ ok: boolean }>('/api/nutrition/settings', settings);
}

/** One nutrient's page: her day's total for it, and the NIH ODS fact sheet's own words. */
export function getNutrient(key: string, signal?: AbortSignal) {
  return api.get<NutrientDetail>(`/api/nutrition/nutrient/${encodeURIComponent(key)}`, signal);
}

export function getHighlights(signal?: AbortSignal) {
  return api.get<{ foods: HighlightedFood[] }>('/api/nutrition/highlights', signal);
}

/** Star (on) or unstar a food she's interested in eating. */
export function setHighlight(food: { fdc_id: number; description: string }, on: boolean) {
  return api.post<{ ok: boolean; foods: HighlightedFood[] }>(`/api/nutrition/highlights/${food.fdc_id}`, {
    on,
    description: food.description,
  });
}
