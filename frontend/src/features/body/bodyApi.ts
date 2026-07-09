/** Body-tab API helpers over the shared fetch client. Endpoints verified
 * against the legacy JS: overview.js (/api/symptoms, /api/food/set),
 * food.js (/api/food/log), health.js (/api/symptom-definitions),
 * kitchen.js (/api/kitchen/safety-tag, /api/body/test/*). */
import { api } from '../../api/client';
import type { BodyData, FoodTest, FoodTestOutcome, SymptomDefinitions } from './types';

export function getBodyData(signal?: AbortSignal): Promise<BodyData> {
  return api.get<BodyData>('/api/data/body', signal);
}

/** Numeric symptom levels as POSTed to /api/symptoms (nose_spray as 0/1). */
export type SymptomPayload = Record<string, number>;

export function logSymptoms(date: string, symptoms: SymptomPayload): Promise<{ ok: boolean }> {
  return api.post('/api/symptoms', { date, symptoms });
}

/** Replace (not append) a date's food notes — the day editor / food-log edit path. */
export function setFoodNotes(date: string, foodNotes: string): Promise<{ ok: boolean }> {
  return api.post('/api/food/set', { date, food_notes: foodNotes });
}

/** Append one food to today's log. */
export function logFood(food: string): Promise<{ ok: boolean }> {
  return api.post('/api/food/log', { food });
}

export function saveSymptomDefinitions(definitions: SymptomDefinitions): Promise<{ ok: boolean }> {
  return api.post('/api/symptom-definitions', { definitions });
}

/** tag '' clears the tag (sends the food back to triage). */
export function setSafetyTag(name: string, tag: string): Promise<{ ok: boolean }> {
  return api.post('/api/kitchen/safety-tag', { name, tag });
}

// --- Food experiments (routes/food_test.py) ---

export function foodTestStart(food: string): Promise<{ ok: boolean; test: FoodTest }> {
  return api.post('/api/body/test/start', { food });
}

export function foodTestOutcome(
  id: string,
  outcome: FoodTestOutcome,
  flareNotes: string,
): Promise<{ ok: boolean; test: FoodTest }> {
  return api.post('/api/body/test/outcome', { id, outcome, flare_notes: flareNotes });
}

export function foodTestExtend(id: string, days: number): Promise<{ ok: boolean; test: FoodTest }> {
  return api.post('/api/body/test/extend', { id, days });
}

export function foodTestCancel(id: string): Promise<{ ok: boolean }> {
  return api.post('/api/body/test/cancel', { id });
}

export function foodTestClearBaseline(): Promise<{ ok: boolean; test: FoodTest }> {
  return api.post('/api/body/test/clear-baseline');
}

export function foodTestLogRetro(food: string, flareNotes: string): Promise<{ ok: boolean; test: FoodTest }> {
  return api.post('/api/body/test/log-retro', { food, flare_notes: flareNotes });
}

export function foodTestQueueAdd(food: string): Promise<{ ok: boolean; queue: string[] }> {
  return api.post('/api/body/test/queue/add', { food });
}

export function foodTestQueueRemove(food: string): Promise<{ ok: boolean; queue: string[] }> {
  return api.post('/api/body/test/queue/remove', { food });
}

export function foodTestQueueReorder(order: string[]): Promise<{ ok: boolean; queue: string[] }> {
  return api.post('/api/body/test/queue/reorder', { order });
}
