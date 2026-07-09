/**
 * recipeHelpers.ts — pure logic for the recipe pipeline: schema-tolerant
 * ingredient readers, list filter/sort, version chains, the send-to-grocery
 * row model (choice groups + member picker), and push-all bucketing.
 * Ports of kitchen-recipes.js's _ingStockingStatus/_ingStoreCategory/
 * renderRecipeCards/_walkRecipeChain/_renderRecipeSendModal/pushAllRecipeToGrocery.
 */
import type { Recipe, RecipeChoiceGroup, RecipeIngredient } from './types';

export const RECIPE_CATEGORIES = [
  'produce', 'vegetables', 'fruit', 'protein', 'dairy', 'grains',
  'drinks', 'snacks', 'dessert', 'pharmacy', 'supplements', 'household', 'other',
];

export const RECIPE_CATEGORY_LABELS: Record<string, string> = {
  produce: 'Produce', vegetables: 'Vegetables', fruit: 'Fruit',
  protein: 'Protein', dairy: 'Dairy', grains: 'Grains',
  drinks: 'Drinks', snacks: 'Snacks', dessert: 'Dessert',
  pharmacy: 'Pharmacy', supplements: 'Supplements', household: 'Household', other: 'Other',
};

/** Stocking status is independent of store category — drives send behavior. */
export const STOCKING_STATUSES = [
  { value: '', label: 'Always send' },
  { value: 'usually_have', label: 'Usually have' },
  { value: 'n_a', label: 'Never (N/A)' },
];

/** Schema-tolerant: legacy data put status in the category field. */
export function ingStockingStatus(ing: RecipeIngredient): string {
  const st = (ing.stocking_status || '').trim();
  if (st === 'n_a' || st === 'usually_have') return st;
  const cat = (ing.category || '').trim();
  if (cat === 'n_a' || cat === 'usually_have') return cat;
  return '';
}

export function ingStoreCategory(ing: RecipeIngredient): string {
  const cat = (ing.category || '').trim();
  if (cat === 'n_a' || cat === 'usually_have') return 'other';
  return cat || 'other';
}

// --- Recipe list (search + sort) ---

export type RecipeSort = 'name' | 'added' | 'time';

export const RECIPE_SORT_KEY = 'kitchen_recipe_sort';

export function readRecipeSort(): RecipeSort {
  try {
    const v = localStorage.getItem(RECIPE_SORT_KEY);
    return v === 'added' || v === 'time' ? v : 'name';
  } catch {
    return 'name';
  }
}

export function writeRecipeSort(mode: RecipeSort) {
  try {
    localStorage.setItem(RECIPE_SORT_KEY, mode);
  } catch {
    // sort just won't persist
  }
}

/** Visible (un-archived) recipes matching the search (name or any ingredient),
 * sorted per mode. */
export function filterSortRecipes(recipes: Recipe[], search: string, sortMode: RecipeSort): Recipe[] {
  const visible = recipes.filter((r) => !r.is_archived);
  const q = (search || '').trim().toLowerCase();
  const filtered = q
    ? visible.filter((r) => {
        if ((r.name || '').toLowerCase().includes(q)) return true;
        return (r.ingredients || []).some((i) => (i.item || '').toLowerCase().includes(q));
      })
    : visible;
  return filtered.slice().sort((a, b) => {
    if (sortMode === 'added') return (b.created || '').localeCompare(a.created || '');
    if (sortMode === 'time') {
      const ta = (Number(a.prep_min) || 0) + (Number(a.cook_min) || 0);
      const tb = (Number(b.prep_min) || 0) + (Number(b.cook_min) || 0);
      return ta - tb;
    }
    return (a.name || '').localeCompare(b.name || '');
  });
}

/** Ancestor chain (parent → grandparent → …) for "Past versions". Cycle-safe. */
export function walkRecipeChain(recipe: Recipe, all: Recipe[]): Recipe[] {
  const chain: Recipe[] = [];
  let cur: Recipe | undefined = recipe;
  const seen = new Set([recipe.id]);
  while (cur && cur.parent_id) {
    const parentId: string = cur.parent_id;
    const parent = all.find((r) => r.id === parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

/** Chip label for a choice-group member — "item · qty" when the ingredient has a qty. */
export function recipeMemberLabel(recipe: Recipe, memberName: string): string {
  const ing = (recipe.ingredients || []).find(
    (i) => (i.item || '').toLowerCase() === (memberName || '').toLowerCase(),
  );
  if (!ing) return memberName;
  const qty = (ing.qty || '').trim();
  return qty ? `${ing.item} · ${qty}` : ing.item || memberName;
}

/** All lowercase group-member names of a recipe. */
export function groupMemberSet(groups: RecipeChoiceGroup[]): Set<string> {
  const memberSet = new Set<string>();
  groups.forEach((g) => (g.members || []).forEach((m) => memberSet.add((m || '').toLowerCase().trim())));
  return memberSet;
}

export interface SendRow {
  name: string;
  qty: string;
  note: string;
  onList: boolean;
  usuallyHave: boolean;
  /** initial checkbox state — needed and not stocked */
  defaultChecked: boolean;
}

/** Non-group, non-N/A ingredients for the send-to-grocery modal. Items already
 * on the list or usually stocked render dimmed + unchecked. */
export function buildSendRows(recipe: Recipe, existingLower: Set<string>): SendRow[] {
  const memberSet = groupMemberSet(recipe.choice_groups || []);
  const rows: SendRow[] = [];
  (recipe.ingredients || []).forEach((ing) => {
    const name = (ing.item || '').trim();
    if (!name) return;
    const nameLower = name.toLowerCase();
    if (memberSet.has(nameLower)) return; // handled by the group chips
    const status = ingStockingStatus(ing);
    if (status === 'n_a') return; // hidden from the modal
    const usuallyHave = status === 'usually_have';
    const onList = existingLower.has(nameLower);
    rows.push({
      name,
      qty: (ing.qty || '').trim(),
      note: (ing.note || '').trim(),
      onList,
      usuallyHave,
      defaultChecked: !onList && !usuallyHave,
    });
  });
  return rows;
}

/** All choice groups have exactly pick_n selections. */
export function allGroupsValid(groups: RecipeChoiceGroup[], picks: Record<string, Set<string>>): boolean {
  return groups.every((g) => {
    const selected = picks[String(g.id ?? '')] || new Set<string>();
    return selected.size === (Number(g.pick_n) || 1);
  });
}

/** Initial picks state from recipe.last_picks. */
export function initialPicks(recipe: Recipe): Record<string, Set<string>> {
  const picks: Record<string, Set<string>> = {};
  (recipe.choice_groups || []).forEach((g) => {
    const gid = String(g.id ?? '');
    const prev = (recipe.last_picks && recipe.last_picks[gid]) || [];
    picks[gid] = new Set(prev);
  });
  return picks;
}

// --- Push-all bucketing ---

export interface PushAllBuckets {
  willAdd: RecipeIngredient[];
  skippedNa: RecipeIngredient[];
  skippedStocked: RecipeIngredient[];
  skippedOnList: RecipeIngredient[];
  skippedUnpicked: RecipeIngredient[];
  /** false when the recipe has groups without a complete last-picks memory —
   * push-all must fall back to the picker. */
  canPush: boolean;
}

/** What would happen on push-all: buckets every ingredient by outcome. For
 * grouped recipes only members present in last_picks are "willAdd". */
export function bucketPushAll(recipe: Recipe, existingLower: Set<string>): PushAllBuckets {
  const groups = recipe.choice_groups || [];
  const out: PushAllBuckets = {
    willAdd: [], skippedNa: [], skippedStocked: [], skippedOnList: [], skippedUnpicked: [],
    canPush: true,
  };
  if (groups.length) {
    const hasAllLastPicks = groups.every((g) => {
      const gid = String(g.id ?? '');
      const prev = (recipe.last_picks && recipe.last_picks[gid]) || [];
      return prev.length === (Number(g.pick_n) || 1);
    });
    if (!hasAllLastPicks) {
      out.canPush = false;
      return out;
    }
  }
  const memberSet = groupMemberSet(groups);
  const lastPickSet = new Set<string>();
  groups.forEach((g) => {
    const gid = String(g.id ?? '');
    ((recipe.last_picks && recipe.last_picks[gid]) || []).forEach((m) =>
      lastPickSet.add((m || '').toLowerCase().trim()),
    );
  });
  (recipe.ingredients || []).forEach((ing) => {
    const name = (ing.item || '').trim();
    if (!name) return;
    const nameLower = name.toLowerCase();
    const status = ingStockingStatus(ing);
    if (status === 'n_a') {
      out.skippedNa.push(ing);
      return;
    }
    if (memberSet.has(nameLower)) {
      if (lastPickSet.has(nameLower)) {
        if (existingLower.has(nameLower)) out.skippedOnList.push(ing);
        else out.willAdd.push(ing);
      } else {
        out.skippedUnpicked.push(ing);
      }
      return;
    }
    if (status === 'usually_have') {
      out.skippedStocked.push(ing);
      return;
    }
    if (existingLower.has(nameLower)) {
      out.skippedOnList.push(ing);
      return;
    }
    out.willAdd.push(ing);
  });
  return out;
}
