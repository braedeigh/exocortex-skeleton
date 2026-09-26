/**
 * api.ts — kitchen endpoint helpers over the shared client. Endpoint paths
 * verified against static/js/kitchen.js, kitchen-recipes.js and
 * routes/kitchen/*.py.
 */
import { api, ApiError } from '../../api/client';
import type {
  FoodTest,
  KitchenData,
  ListVerdicts,
  VerdictReview,
  ParsedReceiptMeta,
  ParsedRecipeMeta,
  Recipe,
  ReceiptHeader,
  ReceiptRow,
} from './types';
import type { LearnRule } from './receiptHelpers';

// --- Primary data ---

export function getKitchenData(signal?: AbortSignal) {
  return api.get<KitchenData>('/api/data/kitchen', signal);
}

// --- Buy organic or not, per grocery-list item (routes/food.py) ---

export function getListVerdicts(signal?: AbortSignal) {
  return api.get<ListVerdicts>('/api/food/list-verdicts', signal);
}

export function runEstimates(force = false) {
  return api.post<{ ok: boolean }>('/api/food/estimates/run', { force });
}

export function reviewEstimate(id: number, review: VerdictReview) {
  return api.post<{ ok: boolean }>(`/api/food/estimates/${id}/review`, { review });
}

// --- Grocery list ---

export function addGrocery(name: string, category?: string) {
  return api.post('/api/kitchen/add', category ? { name, category } : { name });
}

export function addGroceryWithCategory(name: string, category: string) {
  return api.post('/api/kitchen/add-with-category', { name, category });
}

export function removeGrocery(name: string) {
  return api.post('/api/kitchen/remove', { name });
}

export function toggleGrocery(name: string) {
  return api.post<{ all_checked?: boolean }>('/api/kitchen/toggle', { name });
}

/** Clears CHECKED items (finishes the trip). */
export function clearGroceryChecked() {
  return api.post('/api/kitchen/clear', {});
}

/** Clears EVERYTHING, checked and unchecked. Does not log a trip. */
export function clearGroceryAll() {
  return api.post('/api/kitchen/clear-all', {});
}

export function setGroceryItemNote(name: string, note: string) {
  return api.post('/api/kitchen/item/note', { name, note });
}

export function setSafetyTag(name: string, tag: string) {
  return api.post('/api/kitchen/safety-tag', { name, tag });
}

/** location: 'section:<name>' | 'aisle:<N>' */
export function setItemLocation(name: string, location: string) {
  return api.post('/api/kitchen/location/set', { name, location });
}

// --- Categories ---

export function saveCategoryOrder(order: string[]) {
  return api.post('/api/kitchen/category-order', { order });
}

export function renameCategory(oldName: string, newName: string) {
  return api.post<{ error?: string }>('/api/kitchen/category/rename', { old: oldName, new: newName });
}

export function deleteCategory(name: string, reassignTo: string) {
  return api.post<{ error?: string }>('/api/kitchen/category/delete', { name, reassign_to: reassignTo });
}

// --- Catalog ---

export function addCatalogItem(name: string, category: string) {
  return api.post('/api/kitchen/catalog/add', { name, category });
}

export function removeCatalogItem(name: string) {
  return api.post('/api/kitchen/catalog/remove', { name });
}

export function renameCatalogItem(oldName: string, newName: string) {
  return api.post<{ error?: string }>('/api/kitchen/catalog/rename', { old_name: oldName, new_name: newName });
}

export function saveCatalogNote(name: string, note: string) {
  return api.post('/api/kitchen/catalog/note', { name, note });
}

// --- Meal notes ---

export function addMealNote(text: string) {
  return api.post('/api/kitchen/meal-notes', { text });
}

export function deleteMealNote(index: number) {
  return api.post('/api/kitchen/meal-notes/delete', { index });
}

// --- File uploads (multipart — the shared client is JSON-only, so this mirrors
// its 401/error handling with a FormData body) ---

async function uploadFile<T>(path: string, file: File, field = 'photo'): Promise<T> {
  const fd = new FormData();
  fd.append(field, file);
  const res = await fetch(path, { method: 'POST', body: fd, credentials: 'include' });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText || `Upload failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export function scanReceipt(file: File) {
  return uploadFile<{ ok?: boolean; filename?: string; newly_spawned?: boolean }>(
    '/api/kitchen/scan-receipt',
    file,
  );
}

export function scanRecipeImage(file: File) {
  return uploadFile<{ ok?: boolean; error?: string }>('/api/kitchen/scan-recipe', file);
}

// --- Parsed receipts ---

export function listParsedReceipts(signal?: AbortSignal) {
  return api.get<{ receipts: ParsedReceiptMeta[] }>('/api/kitchen/parsed-receipts/list', signal);
}

export function previewParsedReceipt(filename: string) {
  return api.post<{ header?: ReceiptHeader; rows?: ReceiptRow[]; error?: string }>(
    '/api/kitchen/parsed-receipts/preview',
    { filename },
  );
}

export function importParsedReceipt(
  filename: string,
  selections: ReceiptRow[],
  learnRules: LearnRule[],
  updatePantry: boolean,
) {
  return api.post<{ error?: string }>('/api/kitchen/parsed-receipts/import', {
    filename,
    selections,
    learn_rules: learnRules,
    update_pantry: updatePantry,
  });
}

// --- Recipes pipeline ---

export function parseRecipeUrl(url: string) {
  return api.post<{ error?: string }>('/api/kitchen/parse-recipe-url', { url });
}

export function listParsedRecipes(signal?: AbortSignal) {
  return api.get<{ recipes: ParsedRecipeMeta[] }>('/api/kitchen/parsed-recipes/list', signal);
}

export function previewParsedRecipe(filename: string) {
  return api.post<Recipe & { error?: string }>('/api/kitchen/parsed-recipes/preview', { filename });
}

export function discardParsedRecipe(filename: string) {
  return api.post('/api/kitchen/parsed-recipes/discard', { filename });
}

export function saveRecipe(recipe: Recipe, parsedFilename?: string) {
  return api.post<{ ok?: boolean; error?: string }>(
    '/api/kitchen/recipes/save',
    parsedFilename ? { parsed_filename: parsedFilename, recipe } : { recipe },
  );
}

export function saveRecipeAsVariant(recipe: Recipe) {
  return api.post<{ id: string; error?: string }>('/api/kitchen/recipes/save-as-variant', { recipe });
}

export function saveRecipeMyNotes(id: string, myNotes: string) {
  return api.post('/api/kitchen/recipes/my-notes/save', { id, my_notes: myNotes });
}

export function removeRecipe(id: string) {
  return api.post('/api/kitchen/recipes/remove', { id });
}

export interface ToGroceryResult {
  added: number;
  skipped_already_on_list?: number;
  skipped_unchecked?: number;
  skipped_na?: number;
  skipped_unpicked?: number;
  error?: string;
}

export function recipeToGrocery(id: string, skip: string[], picks: Record<string, string[]>) {
  return api.post<ToGroceryResult>('/api/kitchen/recipes/to-grocery', { id, skip, picks });
}

// --- This Week's Meal (meal defaults) ---

export function setMealProtein(protein: string) {
  return api.post('/api/meal-defaults/this-week/protein', { protein });
}

export function setMealVegetables(vegetables: string[]) {
  return api.post('/api/meal-defaults/this-week/vegetables', { vegetables });
}

export function toggleMealSalad(enabled: boolean) {
  return api.post('/api/meal-defaults/side-salad/toggle', { enabled });
}

export interface GenerateListResult {
  added?: string[];
  skipped_in_pantry?: string[];
  skipped_already_on_list?: string[];
  error?: string;
}

export function generateWeeklyList() {
  return api.post<GenerateListResult>('/api/meal-defaults/generate-list', {});
}

// --- Food experiments (Body-tab cards owned by kitchen.js) ---

export function foodTestStart(food: string) {
  return api.post<{ error?: string }>('/api/body/test/start', { food });
}

export function foodTestOutcome(id: string, outcome: string, flareNotes: string) {
  return api.post<{ error?: string }>('/api/body/test/outcome', { id, outcome, flare_notes: flareNotes });
}

export function foodTestExtend(id: string, days: number) {
  return api.post('/api/body/test/extend', { id, days });
}

export function foodTestCancel(id: string) {
  return api.post('/api/body/test/cancel', { id });
}

export function foodTestClearBaseline() {
  return api.post('/api/body/test/clear-baseline');
}

export function foodTestQueueAdd(food: string) {
  return api.post<{ error?: string }>('/api/body/test/queue/add', { food });
}

export function foodTestQueueRemove(food: string) {
  return api.post('/api/body/test/queue/remove', { food });
}

export function foodTestQueueReorder(order: string[]) {
  return api.post('/api/body/test/queue/reorder', { order });
}

export function foodTestLogRetro(food: string, flareNotes: string) {
  return api.post<{ error?: string }>('/api/body/test/log-retro', { food, flare_notes: flareNotes });
}

export type { FoodTest };
