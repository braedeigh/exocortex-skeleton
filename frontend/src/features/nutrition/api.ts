/**
 * api.ts — the nutrition endpoints (routes/nutrition.py) over the shared client.
 */
import { api } from '../../api/client';
import type { FdcFood, MealItem, NutritionDay, SexSetting } from './types';

export function getDay(signal?: AbortSignal) {
  return api.get<NutritionDay>('/api/nutrition/day', signal);
}

export function searchFoods(query: string, signal?: AbortSignal) {
  return api.get<{ foods: FdcFood[] }>(`/api/nutrition/search?q=${encodeURIComponent(query)}`, signal);
}

export function saveMeal(name: string, items: MealItem[]) {
  return api.post<{ ok: boolean }>(`/api/nutrition/meals/${encodeURIComponent(name)}`, { items });
}

export function saveSettings(settings: { sex?: SexSetting; age?: number }) {
  return api.post<{ ok: boolean }>('/api/nutrition/settings', settings);
}
