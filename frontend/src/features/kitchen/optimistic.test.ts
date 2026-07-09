import { describe, expect, it } from 'vitest';
import {
  applyAdd,
  applyCatalogNote,
  applyCategoryOrder,
  applyCheckAll,
  applyClearAll,
  applyClearChecked,
  applyGroceryNote,
  applyLocation,
  applyRecipeMyNotes,
  applyRecipeRemove,
  applyRemove,
  applySafetyTag,
  applyToggle,
} from './optimistic';
import type { KitchenData } from './types';

function base(): KitchenData {
  return {
    kitchen_list: [
      { name: 'Milk', checked: false, category: 'dairy' },
      { name: 'Kale', checked: true, category: 'vegetables' },
    ],
    kitchen_known_items: { milk: 'dairy', kale: 'vegetables' },
    kitchen_aisles: {},
    kitchen_safety_tags: {},
    kitchen_item_notes: {},
    recipes: [{ id: 'r1', name: 'Stew' }],
  };
}

describe('grocery list updaters', () => {
  it('applyToggle flips checked case-insensitively', () => {
    const next = applyToggle(base(), 'milk');
    expect(next.kitchen_list![0].checked).toBe(true);
  });

  it('applyRemove drops the item', () => {
    const next = applyRemove(base(), 'Milk');
    expect(next.kitchen_list!.map((i) => i.name)).toEqual(['Kale']);
  });

  it('applyAdd capitalizes, uses the known category, and no-ops duplicates', () => {
    const withKnown = applyAdd({ ...base(), kitchen_known_items: { bread: 'grains' } }, 'bread');
    expect(withKnown.kitchen_list!.at(-1)).toMatchObject({ name: 'Bread', category: 'grains', checked: false });
    const dup = applyAdd(base(), 'milk');
    expect(dup.kitchen_list).toHaveLength(2);
  });

  it('applyAdd records a new item in the catalog with its picked category', () => {
    const next = applyAdd(base(), 'dragonfruit', 'fruit');
    expect(next.kitchen_known_items!.dragonfruit).toBe('fruit');
  });

  it('applyClearChecked keeps only unchecked; applyClearAll empties; applyCheckAll checks all', () => {
    expect(applyClearChecked(base()).kitchen_list!.map((i) => i.name)).toEqual(['Milk']);
    expect(applyClearAll(base()).kitchen_list).toEqual([]);
    expect(applyCheckAll(base()).kitchen_list!.every((i) => i.checked)).toBe(true);
  });

  it('applyGroceryNote sets the line note', () => {
    const next = applyGroceryNote(base(), 'Milk', 'oat, 2 cartons');
    expect(next.kitchen_list![0].note).toBe('oat, 2 cartons');
  });
});

describe('catalog / tags updaters', () => {
  it('applySafetyTag stores lowercase and clears on empty tag', () => {
    const tagged = applySafetyTag(base(), 'Milk', 'suspect');
    expect(tagged.kitchen_safety_tags).toEqual({ milk: 'suspect' });
    const cleared = applySafetyTag(tagged, 'MILK', '');
    expect(cleared.kitchen_safety_tags).toEqual({});
  });

  it('applyCatalogNote sets and clears the note dot source', () => {
    const withNote = applyCatalogNote(base(), 'milk', 'reacts?');
    expect(withNote.kitchen_item_notes).toEqual({ milk: 'reacts?' });
    expect(applyCatalogNote(withNote, 'milk', '').kitchen_item_notes).toEqual({});
  });

  it('applyLocation aisle sets the aisle map and flips the category to @aisles', () => {
    const next = applyLocation(base(), 'Milk', 'aisle:5');
    expect(next.kitchen_aisles).toEqual({ milk: 5 });
    expect(next.kitchen_known_items!.milk).toBe('@aisles');
  });

  it('applyLocation section clears the aisle and stores the section', () => {
    const aisled = applyLocation(base(), 'Milk', 'aisle:5');
    const next = applyLocation(aisled, 'Milk', 'section:dairy');
    expect(next.kitchen_aisles).toEqual({});
    expect(next.kitchen_known_items!.milk).toBe('dairy');
  });

  it('applyCategoryOrder replaces the order', () => {
    expect(applyCategoryOrder(base(), ['a', 'b']).kitchen_category_order).toEqual(['a', 'b']);
  });
});

describe('recipe updaters', () => {
  it('applyRecipeMyNotes writes onto the matching recipe', () => {
    const next = applyRecipeMyNotes(base(), 'r1', 'less salt');
    expect(next.recipes![0].my_notes).toBe('less salt');
  });

  it('applyRecipeRemove drops the recipe', () => {
    expect(applyRecipeRemove(base(), 'r1').recipes).toEqual([]);
  });
});
