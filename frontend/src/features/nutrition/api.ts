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

export function searchFoods(query: string, signal?: AbortSignal) {
  return api.get<{ foods: FdcFood[] }>(`/api/nutrition/search?q=${encodeURIComponent(query)}`, signal);
}

/** Every USDA food ranked by one nutrient; lowHistamine keeps only the foods SIGHI rates 0. */
export function rankFoods(
  key: string,
  per: RankPer,
  words: string,
  limit: number,
  lowHistamine: boolean,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ per, q: words, limit: String(limit) });
  if (lowHistamine) query.set('histamine', 'low');
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
