/**
 * catalogHelpers.ts — pure logic for the grocery list + "My Foods" catalog:
 * category config, chip filtering/ranking (the old autocomplete), grocery-list
 * aisle-aware grouping, and My Foods sort modes. Ports of kitchen.js's
 * _kitchenCats/_ensureHousehold/_catalogChipsHtml/renderGroceryInto grouping.
 */
import type { GroceryItem, KitchenData } from './types';

export const DEFAULT_CATEGORY_ORDER = [
  'vegetables', 'produce', 'fruit', 'grains', 'drinks', 'snacks',
  'dessert', 'other', 'dairy', 'protein', 'pharmacy', 'supplements',
];

export const CATEGORY_LABELS: Record<string, string> = {
  produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
  protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
  drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert', other: 'Other',
  pharmacy: 'Pharmacy', supplements: 'Supplements',
};

export const AISLES_SENTINEL = '@aisles';

/** 'household' is frontend-only — the server stores arbitrary category
 * strings, so we just make sure it's selectable everywhere. */
export function kitchenCats(order?: string[]): { categoryOrder: string[]; categoryLabels: Record<string, string> } {
  const categoryOrder = (order && order.length ? order : DEFAULT_CATEGORY_ORDER).slice();
  const categoryLabels: Record<string, string> = { ...CATEGORY_LABELS };
  if (!categoryOrder.includes('household')) categoryOrder.push('household');
  categoryLabels.household = 'Household';
  return { categoryOrder, categoryLabels };
}

export function categoryLabel(cat: string, labels: Record<string, string> = CATEGORY_LABELS): string {
  return labels[cat] || cat;
}

export function capitalize(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

// --- Chip filter ranking (the "autocomplete") ---

/** name-prefix match → word-prefix → substring → no match. */
export function prefixRank(name: string, q: string): number {
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s-]+/).some((w) => w.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

export interface CatalogItem {
  name: string;
  cat: string;
  count: number;
}

/** Non-household catalog entries matching `filter`, sorted like the old chips:
 * with a filter — prefix rank, then count desc, then alpha; without — count
 * desc, then alpha. */
export function filterCatalogItems(
  known: Record<string, string>,
  counts: Record<string, number>,
  filter: string,
): CatalogItem[] {
  const q = (filter || '').toLowerCase().trim();
  return Object.entries(known)
    .map(([name, cat]) => ({ name, cat, count: counts[name] || 0 }))
    .filter((i) => i.cat !== 'household')
    .filter((i) => !q || i.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (q) {
        const r = prefixRank(a.name, q) - prefixRank(b.name, q);
        if (r !== 0) return r;
      }
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
}

/** Household items ("Other grocery items" sub-section), alphabetical. */
export function householdItems(
  known: Record<string, string>,
  counts: Record<string, number>,
): CatalogItem[] {
  return Object.entries(known)
    .filter(([, cat]) => cat === 'household')
    .map(([name, cat]) => ({ name, cat, count: counts[name] || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type MyFoodsSort = 'alpha' | 'frequency' | 'both';

export interface ChipGroups {
  mode: MyFoodsSort;
  /** alpha mode: single flat A–Z list */
  alpha?: CatalogItem[];
  /** both/frequency: "Most bought" strip */
  mostBought?: CatalogItem[];
  /** both: "Everything else (A–Z)" */
  restAlpha?: CatalogItem[];
  /** frequency: category subgroups (ordered) */
  byCategory?: { cat: string; label: string; items: CatalogItem[] }[];
}

const BOTH_TOP_N = 10;

/** Groups filtered catalog items per the My Foods sort mode (kitchen.js
 * _catalogChipsHtml's three branches). */
export function groupChips(
  items: CatalogItem[],
  sortMode: MyFoodsSort,
  categoryOrder: string[],
  categoryLabels: Record<string, string>,
): ChipGroups {
  if (sortMode === 'alpha') {
    return { mode: 'alpha', alpha: items.slice().sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (sortMode === 'both') {
    const byFreq = items.slice().sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
    const mostBought = byFreq.filter((i) => i.count > 0).slice(0, BOTH_TOP_N);
    const topSet = new Set(mostBought.map((i) => i.name));
    const restAlpha = items.filter((i) => !topSet.has(i.name)).sort((a, b) => a.name.localeCompare(b.name));
    return { mode: 'both', mostBought, restAlpha };
  }
  // 'frequency' — legacy: Most bought (count > 0, pre-sorted order) + category subgroups of the rest
  const mostBought = items.filter((i) => i.count > 0);
  const rest = items.filter((i) => i.count === 0);
  const catGroups: Record<string, CatalogItem[]> = {};
  rest.forEach((item) => {
    (catGroups[item.cat] ||= []).push(item);
  });
  const catsWithItems = categoryOrder.filter((c) => catGroups[c]);
  Object.keys(catGroups).forEach((c) => {
    if (!catsWithItems.includes(c)) catsWithItems.push(c);
  });
  return {
    mode: 'frequency',
    mostBought,
    byCategory: catsWithItems.map((cat) => ({
      cat,
      label: categoryLabels[cat] || cat,
      items: catGroups[cat],
    })),
  };
}

// --- Grocery list grouping (aisle-aware) ---

export interface GroceryGroup {
  label: string;
  sortIdx: number;
  aisleNum: number;
  items: GroceryItem[];
}

/** Buckets unchecked items into rendered label groups. Items with a known
 * aisle land under "Aisle N" labels, which collectively sit at the position
 * of the '@aisles' sentinel in category_order; everything else buckets by
 * category (unknown categories sink to the bottom). */
export function groupGroceryItems(
  unchecked: GroceryItem[],
  categoryOrder: string[],
  categoryLabels: Record<string, string>,
  aislesMap: Record<string, number>,
): GroceryGroup[] {
  const aislesIdx = categoryOrder.indexOf(AISLES_SENTINEL);
  const groups: Record<string, GroceryGroup> = {};
  unchecked.forEach((item) => {
    const cat = (item.category || 'other').toLowerCase();
    const aisle = aislesMap[item.name.toLowerCase()];
    if (aisle != null && aislesIdx >= 0) {
      const key = `@aisle_${aisle}`;
      groups[key] ||= { label: `Aisle ${aisle}`, sortIdx: aislesIdx, aisleNum: aisle, items: [] };
      groups[key].items.push(item);
    } else {
      const key = `cat_${cat}`;
      if (!groups[key]) {
        const idx = categoryOrder.indexOf(cat);
        groups[key] = {
          label: categoryLabels[cat] || cat,
          sortIdx: idx === -1 ? 9999 : idx,
          aisleNum: 0,
          items: [],
        };
      }
      groups[key].items.push(item);
    }
  });
  return Object.values(groups).sort(
    (a, b) => (a.sortIdx - b.sortIdx) || (a.aisleNum - b.aisleNum) || a.label.localeCompare(b.label),
  );
}

// --- Add flow classification ---

export type AddOutcome = 'already-on-list' | 'known' | 'unknown';

/** How adding `name` should behave: no-op if on the list, direct add when the
 * catalog knows it, otherwise the category-picker modal. */
export function classifyAdd(name: string, data: KitchenData): AddOutcome {
  const items = data.kitchen_list || [];
  if (items.some((i) => i.name.toLowerCase() === name.toLowerCase())) return 'already-on-list';
  const known = data.kitchen_known_items || {};
  if (known[name.toLowerCase()]) return 'known';
  return 'unknown';
}

// --- Safety cycle ---

/** Grocery-row safety button cycle: untagged → safe → suspect → inflammatory → untagged. */
export function nextSafetyTag(current: string): string {
  return current === '' ? 'safe'
    : current === 'safe' ? 'suspect'
    : current === 'suspect' ? 'inflammatory'
    : '';
}

// --- localStorage-persisted sort modes (keys preserved from the old app) ---

export const MY_FOODS_SORT_KEY = 'kitchen_my_foods_sort';
const SORT_DEFAULT_MIGRATION_KEY = 'kitchen_sort_default_v2';

export function readMyFoodsSort(): MyFoodsSort {
  try {
    // One-time migration: clear an old 'frequency' default so users land on
    // the newer A–Z default (kitchen.js did this inside the render loop).
    if (!localStorage.getItem(SORT_DEFAULT_MIGRATION_KEY)) {
      if (localStorage.getItem(MY_FOODS_SORT_KEY) === 'frequency') {
        localStorage.removeItem(MY_FOODS_SORT_KEY);
      }
      localStorage.setItem(SORT_DEFAULT_MIGRATION_KEY, '1');
    }
    const v = localStorage.getItem(MY_FOODS_SORT_KEY);
    return v === 'frequency' || v === 'both' ? v : 'alpha';
  } catch {
    return 'alpha';
  }
}

export function writeMyFoodsSort(mode: MyFoodsSort) {
  try {
    localStorage.setItem(MY_FOODS_SORT_KEY, mode);
  } catch {
    // localStorage unavailable — sort just won't persist
  }
}
