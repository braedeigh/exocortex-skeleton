/**
 * optimistic.ts — pure cache updaters applied to the ['data','kitchen'] query
 * before the server responds, for the interactions the old UI reflected
 * immediately. Same pattern as features/todos/optimistic.ts.
 */
import { capitalize } from './catalogHelpers';
import { AISLES_SENTINEL } from './catalogHelpers';
import { parseLocationVal } from './receiptHelpers';
import type { KitchenData } from './types';

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function applyToggle(data: KitchenData, name: string): KitchenData {
  return {
    ...data,
    kitchen_list: (data.kitchen_list || []).map((i) =>
      sameName(i.name, name) ? { ...i, checked: !i.checked } : i,
    ),
  };
}

export function applyRemove(data: KitchenData, name: string): KitchenData {
  return {
    ...data,
    kitchen_list: (data.kitchen_list || []).filter((i) => !sameName(i.name, name)),
  };
}

/** Add to the list; the display name is capitalized like the server does. */
export function applyAdd(data: KitchenData, name: string, category?: string): KitchenData {
  const list = data.kitchen_list || [];
  if (list.some((i) => sameName(i.name, name))) return data;
  const known = data.kitchen_known_items || {};
  const cat = category || known[name.toLowerCase()] || 'other';
  return {
    ...data,
    kitchen_list: [...list, { name: capitalize(name), category: cat, checked: false }],
    kitchen_known_items: { ...known, [name.toLowerCase()]: cat },
  };
}

/** "Clear checked" (POST /api/kitchen/clear) — checked items leave the list. */
export function applyClearChecked(data: KitchenData): KitchenData {
  return {
    ...data,
    kitchen_list: (data.kitchen_list || []).filter((i) => !i.checked),
  };
}

/** "Clear all" (POST /api/kitchen/clear-all) — everything leaves the list. */
export function applyClearAll(data: KitchenData): KitchenData {
  return { ...data, kitchen_list: [] };
}

export function applyCheckAll(data: KitchenData): KitchenData {
  return {
    ...data,
    kitchen_list: (data.kitchen_list || []).map((i) => (i.checked ? i : { ...i, checked: true })),
  };
}

/** Set/clear a safety tag (keyed lowercase, like the server store). */
export function applySafetyTag(data: KitchenData, name: string, tag: string): KitchenData {
  const tags = { ...(data.kitchen_safety_tags || {}) };
  const key = name.toLowerCase();
  if (tag) tags[key] = tag;
  else delete tags[key];
  return { ...data, kitchen_safety_tags: tags };
}

/** Grocery-list line note (POST /api/kitchen/item/note). */
export function applyGroceryNote(data: KitchenData, name: string, note: string): KitchenData {
  return {
    ...data,
    kitchen_list: (data.kitchen_list || []).map((i) => (sameName(i.name, name) ? { ...i, note } : i)),
  };
}

/** Catalog item note (POST /api/kitchen/catalog/note) — drives the chip dot. */
export function applyCatalogNote(data: KitchenData, name: string, note: string): KitchenData {
  const notes = { ...(data.kitchen_item_notes || {}) };
  if (note) notes[name] = note;
  else delete notes[name];
  return { ...data, kitchen_item_notes: notes };
}

/** Unified location set (POST /api/kitchen/location/set): an aisle stores the
 * aisle number and flips the catalog category to '@aisles'; a section clears
 * the aisle and stores the section. */
export function applyLocation(data: KitchenData, name: string, location: string): KitchenData {
  const key = name.toLowerCase();
  const aisles = { ...(data.kitchen_aisles || {}) };
  const known = { ...(data.kitchen_known_items || {}) };
  const { category, aisle } = parseLocationVal(location);
  if (aisle != null) {
    aisles[key] = aisle;
    known[key] = AISLES_SENTINEL;
  } else {
    delete aisles[key];
    if (category) known[key] = category;
  }
  return { ...data, kitchen_aisles: aisles, kitchen_known_items: known };
}

export function applyCategoryOrder(data: KitchenData, order: string[]): KitchenData {
  return { ...data, kitchen_category_order: order.slice() };
}

/** Recipe "My notes" save — reflected so navigating away + back keeps it. */
export function applyRecipeMyNotes(data: KitchenData, id: string, myNotes: string): KitchenData {
  return {
    ...data,
    recipes: (data.recipes || []).map((r) => (r.id === id ? { ...r, my_notes: myNotes } : r)),
  };
}

export function applyRecipeRemove(data: KitchenData, id: string): KitchenData {
  return { ...data, recipes: (data.recipes || []).filter((r) => r.id !== id) };
}
